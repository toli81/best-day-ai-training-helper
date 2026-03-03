/**
 * Best Day AI — Phase 1: REP_COUNTER Gatekeeper (Hybrid Architecture)
 *
 * GEMINI watches the video → produces structured exercise index (cheap, native video, 1M context)
 * CLAUDE thinks about the data → consensus, report, refinement (Phase 2+, text only)
 *
 * Uses your EXISTING Gemini API key and @google/genai SDK.
 * No new dependencies needed.
 *
 * FILE: functions/src/agents/repCounterAgent.ts
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExerciseSegment {
  segmentId: string;
  exerciseName: string;
  startTime: number;
  endTime: number;
  setNumber: number;
  totalSetsObserved: number;
  movementType: 'concentric_eccentric' | 'isometric' | 'plyometric' | 'cardio' | 'mobility' | 'other';
  fullReps: number | null;
  partialReps: number | null;
  failedReps: number | null;
  tempo: [number, number, number] | null;
  formBreakdownAtRep: number | null;
  holdTimeSeconds: number | null;
  holdCompleted: boolean | null;
  setDurationSeconds: number;
  restAfterSeconds: number | null;
  weight: string;
  equipment: string[];
  bodyParts: string[];
  tags: string[];
  visualConfidence: number;
  visibilityNotes: string;
}

export interface ExerciseIndex {
  segments: ExerciseSegment[];
  exerciseSummary: ExerciseSummary[];
  totalActiveTime: number;
  totalRestTime: number;
  totalSessionDuration: number;
  emphasisPercentages: {
    upperBody: number;
    lowerBody: number;
    core: number;
    fullBody: number;
  };
  overallConfidence: number;
  flaggedForReview: string[];
  excludedDemonstrations: {
    exerciseName: string;
    startTime: number;
    endTime: number;
    reason: string;
  }[];
}

export interface ExerciseSummary {
  exerciseName: string;
  segmentIds: string[];
  totalSets: number;
  totalReps: number | null;
  totalHoldTime: number | null;
  averageConfidence: number;
}

// ── Gemini Structured Output Schema ─────────────────────────────────────────

const EXERCISE_INDEX_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          segmentId:          { type: 'string' },
          exerciseName:       { type: 'string' },
          startTime:          { type: 'number' },
          endTime:            { type: 'number' },
          setNumber:          { type: 'number' },
          totalSetsObserved:  { type: 'number' },
          movementType:       { type: 'string' },
          fullReps:           { type: 'number' },
          partialReps:        { type: 'number' },
          failedReps:         { type: 'number' },
          tempo:              { type: 'array', items: { type: 'number' } },
          formBreakdownAtRep: { type: 'number' },
          holdTimeSeconds:    { type: 'number' },
          holdCompleted:      { type: 'boolean' },
          setDurationSeconds: { type: 'number' },
          restAfterSeconds:   { type: 'number' },
          weight:             { type: 'string' },
          equipment:          { type: 'array', items: { type: 'string' } },
          bodyParts:          { type: 'array', items: { type: 'string' } },
          tags:               { type: 'array', items: { type: 'string' } },
          visualConfidence:   { type: 'number' },
          visibilityNotes:    { type: 'string' },
        },
        required: [
          'segmentId', 'exerciseName', 'startTime', 'endTime',
          'setNumber', 'movementType', 'setDurationSeconds',
          'weight', 'bodyParts', 'tags', 'visualConfidence',
        ],
      },
    },
    totalActiveTime:      { type: 'number' },
    totalRestTime:        { type: 'number' },
    totalSessionDuration: { type: 'number' },
    emphasisPercentages: {
      type: 'object',
      properties: {
        upperBody: { type: 'number' },
        lowerBody: { type: 'number' },
        core:      { type: 'number' },
        fullBody:  { type: 'number' },
      },
      required: ['upperBody', 'lowerBody', 'core', 'fullBody'],
    },
    overallConfidence:  { type: 'number' },
    flaggedForReview:   { type: 'array', items: { type: 'string' } },
    excludedDemonstrations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          exerciseName: { type: 'string' },
          startTime:    { type: 'number' },
          endTime:      { type: 'number' },
          reason:       { type: 'string' },
        },
        required: ['exerciseName', 'startTime', 'endTime', 'reason'],
      },
    },
  },
  required: [
    'segments', 'totalActiveTime', 'totalRestTime',
    'totalSessionDuration', 'emphasisPercentages',
    'overallConfidence', 'flaggedForReview', 'excludedDemonstrations',
  ],
};

// ── System Prompt (sent to Gemini) ──────────────────────────────────────────

const REP_COUNTER_PROMPT = `You are a PRECISION EXERCISE INDEXER for a personal training video analysis system. You are the FIRST analyst in a multi-agent pipeline. Your output determines what every other specialist agent will analyze, so accuracy is critical.

YOUR MISSION: Watch this training session video and produce a structured Exercise Index — a complete manifest of every exercise the CLIENT performed, with precise timestamps, rep counts, and movement classification.

═══════════════════════════════════════════════════════════════
CRITICAL RULES
═══════════════════════════════════════════════════════════════

1. CLIENT ONLY — EXCLUDE TRAINER DEMONSTRATIONS
   - You will often see the TRAINER demonstrate an exercise before the CLIENT performs it.
   - ONLY count and index the CLIENT's actual working sets.
   - If the trainer shows the movement first, note it in "excludedDemonstrations" but do NOT create a segment for it.
   - How to distinguish: The trainer usually demonstrates briefly (5-15 sec), often while talking/gesturing, then steps aside or moves to spot. The client then takes position and performs the working set with more effort and focus.

2. VISUAL ANALYSIS ONLY — IGNORE ALL AUDIO
   - Do NOT use audio/speech for rep counting.
   - Trainers often count out loud to MOTIVATE (e.g., "give me 3 more!" when the client has done 7 reps, or counting down "5...4...3..." as encouragement). This verbal counting is motivational, NOT an accurate rep count.
   - Count reps ONLY by watching the concentric and eccentric phases of movement visually.
   - Ignore countdown coaching, verbal cues, and motivational counting entirely.

3. MOVEMENT CLASSIFICATION
   - concentric_eccentric: Standard reps with lifting and lowering phase (squats, presses, curls, rows, deadlifts, lunges, etc.)
   - isometric: Static holds under tension (planks, wall sits, dead hangs, static lunges, L-sits, hollow holds, etc.)
     → For isometric: set fullReps/partialReps/failedReps to 0. Populate holdTimeSeconds with the duration. Set holdCompleted to true/false.
   - plyometric: Explosive/jumping movements (box jumps, jump squats, burpees, broad jumps)
   - cardio: Sustained aerobic activity (running, cycling, rowing, jump rope, battle ropes for duration)
   - mobility: Stretching, foam rolling, dynamic warm-up, band pull-aparts for mobility
   - other: Anything that doesn't clearly fit above

4. TIMESTAMP PRECISION
   - startTime: The second the CLIENT begins the first rep or enters the hold position. NOT when they approach the equipment.
   - endTime: The second the CLIENT completes the last rep or releases the hold. NOT when they rack weights or walk away.
   - restAfterSeconds: Gap between this segment's endTime and the next segment's startTime. 0 for the last segment.

5. HONESTY ABOUT UNCERTAINTY
   - If a body part is obscured and you cannot clearly count reps, set visualConfidence below 0.7 and add the segmentId to flaggedForReview.
   - If unsure whether a rep was full or partial, count it as full but note it in visibilityNotes.
   - NEVER guess or hallucinate data you cannot see.

6. EXERCISE GROUPING
   - Same exercise done multiple times (e.g., 3 sets of squats) = separate segments sharing the same exerciseName.
   - setNumber tracks which set of THAT exercise (1, 2, 3...).
   - totalSetsObserved = total sets of that exercise in the session.
   - Supersets: Each exercise is its own segment with correct setNumber.

7. SEGMENT IDs: Use "seg-0", "seg-1", "seg-2" in chronological order.

Return ONLY valid JSON matching the schema. No markdown, no explanation, no preamble.`;

// ── Agent Class ─────────────────────────────────────────────────────────────

export class RepCounterAgent {
  private ai: GoogleGenAI;
  private db: admin.firestore.Firestore;
  private storage: admin.storage.Storage;
  private model: string;

  constructor(model = 'gemini-2.5-flash') {
    const apiKey = functions.config().gemini?.api_key || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY — this should already be set for your existing Gemini functions');
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.db = admin.firestore();
    this.storage = admin.storage();
    this.model = model;
  }

  /**
   * Run the gatekeeper on a full session video.
   * Gemini watches the video. Returns structured ExerciseIndex.
   */
  async analyze(jobId: string): Promise<ExerciseIndex> {
    const startTime = Date.now();
    const jobRef = this.db.collection('analysisJobs').doc(jobId);
    const jobSnap = await jobRef.get();

    if (!jobSnap.exists) throw new Error(`Job ${jobId} not found`);
    const job = jobSnap.data()!;

    await jobRef.update({
      status: 'rep_counter_running',
      updatedAt: admin.firestore.Timestamp.now(),
    });

    // Download video from GCS
    const bucket = this.storage.bucket(process.env.GCS_BUCKET || 'best-day-training-app.firebasestorage.app');
    const file = bucket.file(job.videoPath);
    const [metadata] = await file.getMetadata();
    const fileSizeMB = Number(metadata.size) / (1024 * 1024);

    console.log(`[RepCounter] Video: ${fileSizeMB.toFixed(1)}MB for job ${jobId}`);

    // Download and encode
    const [buffer] = await file.download();
    const base64 = buffer.toString('base64');
    const mimeType = job.videoPath.endsWith('.mp4') ? 'video/mp4' : 'video/webm';

    // Check for trainer-refined prompt
    const customSnap = await this.db.collection('config').doc('agentPrompts').get();
    const prompt = customSnap.exists && customSnap.data()?.REP_COUNTER
      ? customSnap.data()!.REP_COUNTER as string
      : REP_COUNTER_PROMPT;

    // ── Call Gemini ─────────────────────────────────────────────────────
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        { inlineData: { data: base64, mimeType } },
        { text: prompt },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: EXERCISE_INDEX_SCHEMA,
      },
    });

    const text = response.text ?? '';
    if (!text) throw new Error('Gemini returned empty response');

    let exerciseIndex: ExerciseIndex;
    try {
      exerciseIndex = JSON.parse(text);
    } catch (e) {
      console.error('[RepCounter] Parse failed, raw:', text.substring(0, 500));
      throw new Error('Gemini returned invalid JSON');
    }

    // ── Post-process ────────────────────────────────────────────────────
    exerciseIndex.segments = exerciseIndex.segments.map((seg, i) => ({
      ...seg,
      segmentId: seg.segmentId || `seg-${i}`,
      setDurationSeconds: seg.setDurationSeconds || Math.round(seg.endTime - seg.startTime),
    }));

    exerciseIndex.exerciseSummary = this.buildSummaries(exerciseIndex.segments);

    // ── Store results ───────────────────────────────────────────────────
    const processingTimeMs = Date.now() - startTime;

    await jobRef.collection('agentResults').doc('REP_COUNTER').set({
      agentId: 'REP_COUNTER',
      model: this.model,
      engine: 'gemini',
      result: exerciseIndex,
      confidence: exerciseIndex.overallConfidence,
      processingTimeMs,
      completedAt: admin.firestore.Timestamp.now(),
    });

    await jobRef.update({
      exerciseIndex,
      status: 'rep_counter_complete',
      updatedAt: admin.firestore.Timestamp.now(),
    });

    // Backward-compatible write so existing UI works immediately
    const backcompat = this.toSessionAnalysis(exerciseIndex);
    await this.db
      .collection('trainers').doc(job.trainerId)
      .collection('sessions').doc(job.sessionId)
      .update({
        analysis: backcompat,
        status: 'complete',
        analysisStatus: 'rep_counter_complete',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    console.log(`[RepCounter] Done: ${exerciseIndex.segments.length} segments, ` +
      `${exerciseIndex.exerciseSummary.length} exercises, ${processingTimeMs}ms`);

    return exerciseIndex;
  }

  // ── Build summaries ───────────────────────────────────────────────────

  private buildSummaries(segments: ExerciseSegment[]): ExerciseSummary[] {
    const grouped = new Map<string, ExerciseSegment[]>();
    for (const seg of segments) {
      const key = seg.exerciseName.toLowerCase().trim();
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(seg);
    }
    return Array.from(grouped.entries()).map(([_, segs]) => {
      const isIso = segs[0].movementType === 'isometric';
      return {
        exerciseName: segs[0].exerciseName,
        segmentIds: segs.map(s => s.segmentId),
        totalSets: segs.length,
        totalReps: isIso ? null : segs.reduce((sum, s) => sum + (s.fullReps || 0) + (s.partialReps || 0), 0),
        totalHoldTime: isIso ? segs.reduce((sum, s) => sum + (s.holdTimeSeconds || 0), 0) : null,
        averageConfidence: segs.reduce((sum, s) => sum + s.visualConfidence, 0) / segs.length,
      };
    });
  }

  // ── Backward-compat SessionAnalysis ───────────────────────────────────

  private toSessionAnalysis(index: ExerciseIndex): Record<string, unknown> {
    return {
      exercises: index.segments.map(seg => ({
        id: seg.segmentId,
        name: seg.exerciseName,
        startTime: seg.startTime,
        endTime: seg.endTime,
        reps: seg.movementType === 'isometric'
          ? `${seg.holdTimeSeconds}s hold`
          : String((seg.fullReps || 0) + (seg.partialReps || 0)),
        weight: seg.weight,
        duration: `${seg.setDurationSeconds}s`,
        cues: [],
        tags: [...seg.tags, ...seg.bodyParts, seg.movementType],
      })),
      transcript: '',
      summary: `Session indexed: ${index.exerciseSummary.length} unique exercises, ` +
        `${index.segments.length} total sets, ` +
        `${Math.round(index.totalActiveTime / 60)}min active time.`,
      trainerCues: [],
      protocolRecommendations: '',
      emphasisPercentages: index.emphasisPercentages,
    };
  }
}
