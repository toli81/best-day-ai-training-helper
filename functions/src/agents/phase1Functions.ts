/**
 * Best Day AI — Phase 1: Cloud Functions (Hybrid Architecture)
 *
 * Gemini watches video → REP_COUNTER produces Exercise Index
 * Claude thinks about data → CONSENSUS + REPORT (Phase 2+)
 *
 * Pipeline:
 *   Video → GCS → onVideoUploadedDeepAnalysis → analysisJob created
 *   → onAnalysisJobCreated → RepCounterAgent (Gemini) → ExerciseIndex stored
 *   → UI updates via Firestore onSnapshot
 *
 * FILE: functions/src/agents/phase1Functions.ts
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { RepCounterAgent } from './repCounterAgent';
import type { ExerciseIndex } from './repCounterAgent';
import { runPtExpert, runScCoach } from './specialistAgents';
import { runAudioAnalyst } from './audioAnalystAgent';
import { runConsensus, runReportGenerator } from './claudeAgents';

// ── 1. GCS Trigger: Create analysis job on video upload ─────────────────

export const onVideoUploadedDeepAnalysis = functions
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .storage.bucket(process.env.GCS_BUCKET || 'best-day-training-app.firebasestorage.app')
  .object()
  .onFinalize(async (object) => {
    const filePath = object.name;
    if (!filePath) return;

    // Match your existing path pattern
    const match = filePath.match(
      /^trainers\/([^/]+)\/sessions\/([^/]+)\/recording\.(webm|mp4)$/
    );
    if (!match) return;

    const trainerId = match[1];
    const sessionId = match[2];
    const db = admin.firestore();

    // Verify session exists
    const sessionSnap = await db
      .collection('trainers').doc(trainerId)
      .collection('sessions').doc(sessionId)
      .get();

    if (!sessionSnap.exists) {
      console.warn(`[DeepAnalysis] Session ${sessionId} not found, skipping`);
      return;
    }

    // Check trainer opt-out
    const trainerSnap = await db.collection('trainers').doc(trainerId).get();
    if (trainerSnap.exists && trainerSnap.data()?.settings?.deepAnalysisEnabled === false) {
      console.log(`[DeepAnalysis] Disabled for trainer ${trainerId}`);
      return;
    }

    // Prevent duplicate jobs
    const existing = await db
      .collection('analysisJobs')
      .where('sessionId', '==', sessionId)
      .where('trainerId', '==', trainerId)
      .limit(1)
      .get();

    if (!existing.empty) {
      console.log(`[DeepAnalysis] Job already exists for session ${sessionId}`);
      return;
    }

    // Create analysis job → triggers onAnalysisJobCreated
    const jobRef = db.collection('analysisJobs').doc();
    await jobRef.set({
      jobId: jobRef.id,
      sessionId,
      trainerId,
      videoPath: filePath,
      status: 'pending',
      specialistsComplete: 0,
      createdAt: admin.firestore.Timestamp.now(),
      updatedAt: admin.firestore.Timestamp.now(),
    });

    // Link job to session
    await db
      .collection('trainers').doc(trainerId)
      .collection('sessions').doc(sessionId)
      .update({
        analysisJobId: jobRef.id,
        analysisStatus: 'pending',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    console.log(`[DeepAnalysis] Created job ${jobRef.id} for session ${sessionId}`);
  });


// ── 2. Firestore Trigger: Run REP_COUNTER when job created ──────────────

export const onAnalysisJobCreated = functions
  .runWith({
    timeoutSeconds: 540,   // 9 min — Gemini video analysis can take a while
    memory: '2GB',         // Need memory for video download buffer
  })
  .firestore.document('analysisJobs/{jobId}')
  .onCreate(async (snap, context) => {
    const jobId = context.params.jobId;
    const job = snap.data();

    if (job.status !== 'pending') return;

    console.log(`[DeepAnalysis] Starting REP_COUNTER for job ${jobId}`);

    try {
      const agent = new RepCounterAgent();
      const exerciseIndex: ExerciseIndex = await agent.analyze(jobId);

      console.log(
        `[DeepAnalysis] REP_COUNTER complete: ` +
        `${exerciseIndex.segments.length} segments, ` +
        `${exerciseIndex.exerciseSummary.length} unique exercises, ` +
        `confidence: ${exerciseIndex.overallConfidence}, ` +
        `flagged: ${exerciseIndex.flaggedForReview.length}`
      );

      // ─── Phase 2: status update only ─────────────────────────────
      // Actual Phase 2 dispatch is handled by onRepCounterComplete,
      // which fires automatically when status → 'rep_counter_complete'.
      // This keeps Phase 2's timeout budget independent of Phase 1.
      // ─────────────────────────────────────────────────────────────

    } catch (err: any) {
      console.error(`[DeepAnalysis] REP_COUNTER failed for job ${jobId}:`, err);

      await snap.ref.update({
        status: 'failed',
        error: `REP_COUNTER failed: ${err.message}`,
        updatedAt: admin.firestore.Timestamp.now(),
      });

      await admin.firestore()
        .collection('trainers').doc(job.trainerId)
        .collection('sessions').doc(job.sessionId)
        .update({
          analysisStatus: 'failed',
          status: 'failed',
          error: `Deep analysis failed: ${err.message}`,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }
  });


// ── 3. Callable: Manually trigger analysis on existing session ──────────

export const triggerDeepAnalysis = functions
  .runWith({ timeoutSeconds: 540, memory: '2GB' })
  .https.onCall(async (data: { sessionId: string }, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
    }

    const trainerId = context.auth.uid;
    const { sessionId } = data;
    const db = admin.firestore();

    // Verify ownership
    const sessionSnap = await db
      .collection('trainers').doc(trainerId)
      .collection('sessions').doc(sessionId)
      .get();

    if (!sessionSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Session not found');
    }

    const videoPath = sessionSnap.data()?.videoPath;
    if (!videoPath) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No video uploaded for this session yet.'
      );
    }

    // Delete existing jobs for this session (re-run)
    const existingJobs = await db
      .collection('analysisJobs')
      .where('sessionId', '==', sessionId)
      .where('trainerId', '==', trainerId)
      .get();

    for (const doc of existingJobs.docs) {
      const subs = await doc.ref.collection('agentResults').get();
      const batch = db.batch();
      subs.forEach(sub => batch.delete(sub.ref));
      batch.delete(doc.ref);
      await batch.commit();
    }

    // Create fresh job
    const jobRef = db.collection('analysisJobs').doc();
    await jobRef.set({
      jobId: jobRef.id,
      sessionId,
      trainerId,
      videoPath,
      status: 'pending',
      specialistsComplete: 0,
      createdAt: admin.firestore.Timestamp.now(),
      updatedAt: admin.firestore.Timestamp.now(),
    });

    await db
      .collection('trainers').doc(trainerId)
      .collection('sessions').doc(sessionId)
      .update({
        analysisJobId: jobRef.id,
        analysisStatus: 'pending',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Run analysis directly in this callable
    try {
      const agent = new RepCounterAgent();
      const exerciseIndex = await agent.analyze(jobRef.id);

      return {
        jobId: jobRef.id,
        segmentsFound: exerciseIndex.segments.length,
        uniqueExercises: exerciseIndex.exerciseSummary.length,
        confidence: exerciseIndex.overallConfidence,
        flaggedForReview: exerciseIndex.flaggedForReview,
        excludedDemonstrations: exerciseIndex.excludedDemonstrations.length,
      };
    } catch (err: any) {
      throw new functions.https.HttpsError('internal', `Analysis failed: ${err.message}`);
    }
  });


// ── 4. Callable: Get exercise index for a job ───────────────────────────

export const getExerciseIndex = functions
  .https.onCall(async (data: { jobId: string }, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
    }

    const db = admin.firestore();
    const jobSnap = await db.collection('analysisJobs').doc(data.jobId).get();

    if (!jobSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Job not found');
    }

    const job = jobSnap.data()!;
    if (job.trainerId !== context.auth.uid) {
      throw new functions.https.HttpsError('permission-denied', 'Access denied');
    }

    return {
      jobId: data.jobId,
      status: job.status,
      exerciseIndex: job.exerciseIndex || null,
      error: job.error || null,
    };
  });


// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — onRepCounterComplete Trigger + dispatchSpecialists
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fires when a job transitions to 'rep_counter_complete'.
 * Runs all Phase 2 agents (PT_EXPERT, SC_COACH, AUDIO_ANALYST, CONSENSUS, REPORT).
 *
 * Memory: 2GB — shared video buffer is held in-process for PT_EXPERT + AUDIO_ANALYST.
 * Timeout: 540s — sufficient for 60-min sessions (agents run in parallel).
 */
export const onRepCounterComplete = functions
  .runWith({ timeoutSeconds: 540, memory: '2GB' })
  .firestore.document('analysisJobs/{jobId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Only fire on transition TO rep_counter_complete
    if (before.status === after.status) return;
    if (after.status !== 'rep_counter_complete') return;

    const jobId = context.params.jobId;
    console.log(`[Phase2] Triggered for job ${jobId} — starting dispatchSpecialists`);

    try {
      await dispatchSpecialists(jobId, after as { exerciseIndex: ExerciseIndex; videoPath: string; trainerId: string; sessionId: string });
    } catch (err: any) {
      console.error(`[Phase2] dispatchSpecialists failed for job ${jobId}:`, err.message);
      await admin.firestore().collection('analysisJobs').doc(jobId).update({
        status: 'failed',
        error: `Phase 2 failed: ${err.message}`,
        updatedAt: admin.firestore.Timestamp.now(),
      });
    }
  });

/**
 * Downloads video from GCS once, then runs all specialists in parallel.
 * PT_EXPERT and AUDIO_ANALYST share the base64 buffer (no double-download).
 * SC_COACH runs text-only in parallel.
 * Then runs Claude CONSENSUS and REPORT_GENERATOR sequentially.
 */
async function dispatchSpecialists(
  jobId: string,
  job: { exerciseIndex: ExerciseIndex; videoPath: string; trainerId: string; sessionId: string },
): Promise<void> {
  const db = admin.firestore();
  const jobRef = db.collection('analysisJobs').doc(jobId);

  await jobRef.update({
    status: 'specialists_running',
    updatedAt: admin.firestore.Timestamp.now(),
  });

  // Also update the session doc so the UI can show progress immediately
  await db
    .collection('trainers').doc(job.trainerId)
    .collection('sessions').doc(job.sessionId)
    .update({
      analysisStatus: 'specialists_running',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  // ── Download video ONCE — shared by PT_EXPERT and AUDIO_ANALYST ──────────
  const bucketName = process.env.GCS_BUCKET || 'best-day-training-app.firebasestorage.app';
  const bucket = admin.storage().bucket(bucketName);
  const file = bucket.file(job.videoPath);

  console.log(`[Phase2] Downloading video: ${job.videoPath}`);
  const [buffer] = await file.download();
  const videoBase64 = buffer.toString('base64');
  const videoMimeType = job.videoPath.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
  console.log(`[Phase2] Video downloaded — ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);

  // ── Run all three specialists in parallel ─────────────────────────────────
  const specialistResults = await Promise.allSettled([
    runPtExpert(jobId, videoBase64, videoMimeType, job.exerciseIndex),
    runAudioAnalyst(jobId, videoBase64, videoMimeType, job.exerciseIndex),
    runScCoach(jobId, job.exerciseIndex),
  ]);

  // Log any specialist failures (they don't block consensus — graceful degradation)
  specialistResults.forEach((result, i) => {
    const names = ['PT_EXPERT', 'AUDIO_ANALYST', 'SC_COACH'];
    if (result.status === 'rejected') {
      console.warn(`[Phase2] ${names[i]} rejected (non-blocking):`, result.reason);
    }
  });

  // ── CONSENSUS ─────────────────────────────────────────────────────────────
  await jobRef.update({
    status: 'consensus_running',
    updatedAt: admin.firestore.Timestamp.now(),
  });
  await db
    .collection('trainers').doc(job.trainerId)
    .collection('sessions').doc(job.sessionId)
    .update({
      analysisStatus: 'consensus_running',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  await runConsensus(jobId);

  // ── REPORT_GENERATOR ──────────────────────────────────────────────────────
  await jobRef.update({
    status: 'report_generating',
    updatedAt: admin.firestore.Timestamp.now(),
  });
  await db
    .collection('trainers').doc(job.trainerId)
    .collection('sessions').doc(job.sessionId)
    .update({
      analysisStatus: 'report_generating',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  await runReportGenerator(jobId);

  console.log(`[Phase2] Complete for job ${jobId} — status: draft_ready`);
}
