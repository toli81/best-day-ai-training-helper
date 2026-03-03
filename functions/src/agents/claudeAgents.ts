/**
 * Best Day AI — Phase 2: Claude Agents
 *
 * CONSENSUS        — Claude Haiku: reads all specialist results, merges insights
 * REPORT_GENERATOR — Claude Sonnet: produces the final human-readable SessionAnalysis
 *
 * These are text-only calls — no video, no images.
 * Cost: ~$0.01–0.05 per session total.
 *
 * FILE: functions/src/agents/claudeAgents.ts
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import Anthropic from '@anthropic-ai/sdk';
import type { ExerciseIndex } from './repCounterAgent';
import type { PtExpertResult } from './specialistAgents';
import type { ScCoachResult } from './specialistAgents';
import type { AudioAnalystResult } from './audioAnalystAgent';

// ── Output Types ─────────────────────────────────────────────────────────────

export interface ConsensusResult {
  agentId: 'CONSENSUS';
  model: string;
  engine: 'claude';
  exerciseCues: Record<string, string[]>;  // exerciseName → priority cues (3-5)
  sessionSummary: string;
  trainerCues: string[];                   // top session-level directives
  protocolRecommendations: string;
  audioUsed: boolean;
  processingTimeMs: number;
  completedAt: admin.firestore.Timestamp;
}

export interface ReportResult {
  agentId: 'REPORT';
  model: string;
  engine: 'claude';
  sessionAnalysis: GeneratedSessionAnalysis;
  processingTimeMs: number;
  completedAt: admin.firestore.Timestamp;
}

export interface GeneratedSessionAnalysis {
  exercises: GeneratedExercise[];
  transcript: string;
  summary: string;
  trainerCues: string[];
  protocolRecommendations: string;
  emphasisPercentages: {
    upperBody: number;
    lowerBody: number;
    core: number;
    fullBody: number;
  };
}

export interface GeneratedExercise {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  reps: string;
  weight: string;
  duration: string;
  cues: string[];
  tags: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAnthropicClient(): Anthropic {
  const apiKey = functions.config().anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Set it with: firebase functions:config:set anthropic.api_key="sk-ant-..."'
    );
  }
  return new Anthropic({ apiKey });
}

function safeParseJson<T>(text: string, agentName: string): T {
  // Strip markdown code fences if Claude wraps output in them
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    console.error(`[${agentName}] JSON parse failed. Raw (first 500 chars):`, cleaned.substring(0, 500));
    throw new Error(`${agentName}: Claude returned invalid JSON`);
  }
}

// ── CONSENSUS Agent ───────────────────────────────────────────────────────────

export async function runConsensus(jobId: string): Promise<void> {
  const startTime = Date.now();
  const db = admin.firestore();

  console.log(`[CONSENSUS] Starting for job ${jobId}`);

  try {
    // Read all specialist results
    const jobRef = db.collection('analysisJobs').doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) throw new Error(`Job ${jobId} not found`);

    const exerciseIndex = jobSnap.data()!.exerciseIndex as ExerciseIndex;

    const [ptSnap, scSnap, audioSnap] = await Promise.all([
      jobRef.collection('agentResults').doc('PT_EXPERT').get(),
      jobRef.collection('agentResults').doc('SC_COACH').get(),
      jobRef.collection('agentResults').doc('AUDIO_ANALYST').get(),
    ]);

    const ptResult = ptSnap.exists ? (ptSnap.data() as PtExpertResult) : null;
    const scResult = scSnap.exists ? (scSnap.data() as ScCoachResult) : null;
    const audioResult = audioSnap.exists ? (audioSnap.data() as AudioAnalystResult) : null;

    const audioUsed = audioResult?.useable === true;

    // Build the prompt
    const prompt = buildConsensusPrompt(exerciseIndex, ptResult, scResult, audioResult);

    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 4096,
      system: `You are a specialist coordinator for a personal training session analysis system. You synthesize reports from multiple expert agents into a unified, actionable set of coaching priorities. Always respond with valid JSON only — no markdown, no explanation.`,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('');

    const parsed = safeParseJson<{
      exerciseCues: Record<string, string[]>;
      sessionSummary: string;
      trainerCues: string[];
      protocolRecommendations: string;
    }>(rawText, 'CONSENSUS');

    const result: ConsensusResult = {
      agentId: 'CONSENSUS',
      model: 'claude-3-5-haiku-20241022',
      engine: 'claude',
      exerciseCues: parsed.exerciseCues || {},
      sessionSummary: parsed.sessionSummary || '',
      trainerCues: parsed.trainerCues || [],
      protocolRecommendations: parsed.protocolRecommendations || '',
      audioUsed,
      processingTimeMs: Date.now() - startTime,
      completedAt: admin.firestore.Timestamp.now(),
    };

    await jobRef.collection('agentResults').doc('CONSENSUS').set(result);

    console.log(`[CONSENSUS] Done for job ${jobId} — ${result.trainerCues.length} trainer cues in ${result.processingTimeMs}ms`);
  } catch (err: any) {
    console.error(`[CONSENSUS] Failed for job ${jobId}:`, err.message);
    // Store a minimal fallback so REPORT_GENERATOR can still run
    await db.collection('analysisJobs').doc(jobId)
      .collection('agentResults').doc('CONSENSUS')
      .set({
        agentId: 'CONSENSUS',
        engine: 'claude',
        error: err.message,
        exerciseCues: {},
        sessionSummary: '',
        trainerCues: [],
        protocolRecommendations: '',
        audioUsed: false,
        processingTimeMs: Date.now() - startTime,
        completedAt: admin.firestore.Timestamp.now(),
      });
    // Rethrow so the caller knows this step failed
    throw err;
  }
}

function buildConsensusPrompt(
  exerciseIndex: ExerciseIndex,
  ptResult: PtExpertResult | null,
  scResult: ScCoachResult | null,
  audioResult: AudioAnalystResult | null,
): string {
  const ptSection = ptResult && ptResult.exerciseAnalyses?.length > 0
    ? JSON.stringify(ptResult.exerciseAnalyses, null, 2)
    : 'PT_EXPERT data not available.';

  const scSection = scResult && scResult.exerciseAnalyses?.length > 0
    ? `Exercise analyses:\n${JSON.stringify(scResult.exerciseAnalyses, null, 2)}\n\nSession notes:\n${JSON.stringify(scResult.sessionNotes, null, 2)}`
    : 'SC_COACH data not available.';

  const audioSection = audioResult?.useable
    ? `Audio was USEABLE (quality: ${audioResult.audioQuality}).\nTrainer cues extracted:\n${JSON.stringify(audioResult.exerciseCues, null, 2)}\n\nFull transcription summary: ${audioResult.sessionSummary ?? 'none'}`
    : `Audio was NOT useable (quality: ${audioResult?.audioQuality ?? 'unknown'}). Ignore audio data.`;

  const exerciseNames = exerciseIndex.exerciseSummary.map(e => e.exerciseName);

  return `You are synthesizing results from three specialist agents who analysed a personal training session.

═══════════════════════════════════════════════════════════
EXERCISES IN SESSION
═══════════════════════════════════════════════════════════
${exerciseNames.join(', ')}

═══════════════════════════════════════════════════════════
PT_EXPERT (Physical Therapist — watched video for form)
═══════════════════════════════════════════════════════════
${ptSection}

═══════════════════════════════════════════════════════════
SC_COACH (Strength & Conditioning — analysed session data)
═══════════════════════════════════════════════════════════
${scSection}

═══════════════════════════════════════════════════════════
AUDIO_ANALYST (listened to trainer coaching audio)
═══════════════════════════════════════════════════════════
${audioSection}

═══════════════════════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════════════════════

Synthesize the above into a unified coaching output. Return JSON with EXACTLY this structure:

{
  "exerciseCues": {
    "<ExerciseName>": ["cue 1", "cue 2", "cue 3"]
  },
  "sessionSummary": "2-3 sentence narrative describing the session, client performance, and key coaching themes",
  "trainerCues": ["top directive 1", "top directive 2", "top directive 3", "top directive 4", "top directive 5"],
  "protocolRecommendations": "Programming and training protocol notes for the trainer to keep on file"
}

Rules:
- exerciseCues: For EACH exercise in the session, provide 3-5 priority cues merging PT_EXPERT form cues, SC_COACH progression notes, and AUDIO_ANALYST verbal cues (if audio was useable). If audio was NOT useable, use only visual agent data.
- trainerCues: The 3-6 most important session-level takeaways the trainer should remember (not exercise-specific — these are session-level priorities).
- protocolRecommendations: Combine SC_COACH session notes into a concise paragraph about programming direction.
- sessionSummary: Write a clear, professional narrative suitable for a trainer's session notes.
- If a specialist's data was unavailable, synthesize from the remaining agents without mentioning the gap.

Return ONLY valid JSON. No markdown, no explanation.`;
}

// ── REPORT_GENERATOR Agent ────────────────────────────────────────────────────

export async function runReportGenerator(jobId: string): Promise<void> {
  const startTime = Date.now();
  const db = admin.firestore();

  console.log(`[REPORT] Starting for job ${jobId}`);

  try {
    const jobRef = db.collection('analysisJobs').doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) throw new Error(`Job ${jobId} not found`);

    const job = jobSnap.data()!;
    const exerciseIndex = job.exerciseIndex as ExerciseIndex;
    const trainerId: string = job.trainerId;
    const sessionId: string = job.sessionId;

    const consensusSnap = await jobRef.collection('agentResults').doc('CONSENSUS').get();
    const audioSnap = await jobRef.collection('agentResults').doc('AUDIO_ANALYST').get();

    const consensus = consensusSnap.exists ? (consensusSnap.data() as ConsensusResult) : null;
    const audioResult = audioSnap.exists ? (audioSnap.data() as AudioAnalystResult) : null;

    const prompt = buildReportPrompt(exerciseIndex, consensus, audioResult);

    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      system: `You are generating a structured training session analysis report for a personal trainer. The report will be displayed in a professional training app. Always respond with valid JSON only — no markdown, no explanation.`,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('');

    const parsed = safeParseJson<GeneratedSessionAnalysis>(rawText, 'REPORT');

    // Validate and merge with base exercise data from ExerciseIndex
    const finalAnalysis = mergeWithExerciseIndex(parsed, exerciseIndex);

    // Write the final report to the session document
    await db
      .collection('trainers').doc(trainerId)
      .collection('sessions').doc(sessionId)
      .update({
        analysis: finalAnalysis,
        status: 'complete',
        analysisStatus: 'draft_ready',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Update the job document
    await jobRef.update({
      status: 'draft_ready',
      updatedAt: admin.firestore.Timestamp.now(),
    });

    // Store the report result for reference
    await jobRef.collection('agentResults').doc('REPORT').set({
      agentId: 'REPORT',
      model: 'claude-sonnet-4-5',
      engine: 'claude',
      sessionAnalysis: finalAnalysis,
      processingTimeMs: Date.now() - startTime,
      completedAt: admin.firestore.Timestamp.now(),
    } as ReportResult);

    console.log(`[REPORT] Done for job ${jobId} — analysis written to session ${sessionId} in ${Date.now() - startTime}ms`);
  } catch (err: any) {
    console.error(`[REPORT] Failed for job ${jobId}:`, err.message);
    // Mark the job as failed so the UI can show a retry option
    await db.collection('analysisJobs').doc(jobId).update({
      status: 'failed',
      error: `REPORT_GENERATOR failed: ${err.message}`,
      updatedAt: admin.firestore.Timestamp.now(),
    });
    throw err;
  }
}

function buildReportPrompt(
  exerciseIndex: ExerciseIndex,
  consensus: ConsensusResult | null,
  audioResult: AudioAnalystResult | null,
): string {
  const exerciseSummaryText = exerciseIndex.exerciseSummary.map(ex => {
    const cues = consensus?.exerciseCues?.[ex.exerciseName] || [];
    return `${ex.exerciseName}: ${ex.totalSets} sets, ${ex.totalReps ?? ex.totalHoldTime + 's hold'} total, cues=[${cues.join(' | ')}]`;
  }).join('\n');

  const trainerCues = consensus?.trainerCues || [];
  const sessionSummary = consensus?.sessionSummary || '';
  const protocolRecs = consensus?.protocolRecommendations || '';
  const transcript = audioResult?.useable ? (audioResult.fullTranscription || '') : '';

  return `Generate a complete training session analysis report in JSON format.

═══════════════════════════════════════════════════════════
SOURCE DATA
═══════════════════════════════════════════════════════════

Session Duration: ${Math.round(exerciseIndex.totalSessionDuration / 60)} minutes
Active Time: ${Math.round(exerciseIndex.totalActiveTime / 60)} minutes
Body Emphasis: Upper ${exerciseIndex.emphasisPercentages.upperBody}% | Lower ${exerciseIndex.emphasisPercentages.lowerBody}% | Core ${exerciseIndex.emphasisPercentages.core}% | Full Body ${exerciseIndex.emphasisPercentages.fullBody}%

Exercise Summary with Cues:
${exerciseSummaryText}

Trainer Session Summary: ${sessionSummary}

Top Trainer Cues: ${trainerCues.join(' | ')}

Protocol Recommendations: ${protocolRecs}

${transcript ? `Trainer Audio Transcript:\n${transcript.substring(0, 3000)}` : 'No audio transcript available.'}

═══════════════════════════════════════════════════════════
REQUIRED OUTPUT FORMAT
═══════════════════════════════════════════════════════════

Return JSON with EXACTLY this structure:

{
  "exercises": [
    {
      "id": "<segmentId from ExerciseIndex>",
      "name": "<exerciseName>",
      "startTime": <number — seconds>,
      "endTime": <number — seconds>,
      "reps": "<e.g. '10' or '30s hold'>",
      "weight": "<e.g. '135 lbs' or 'bodyweight'>",
      "duration": "<e.g. '45s'>",
      "cues": ["cue 1", "cue 2", "cue 3"],
      "tags": ["tag1", "tag2"]
    }
  ],
  "transcript": "<full trainer transcription, or empty string if unavailable>",
  "summary": "<2-3 sentence professional session narrative for the trainer's records>",
  "trainerCues": ["directive 1", "directive 2", "directive 3"],
  "protocolRecommendations": "<programming notes paragraph>",
  "emphasisPercentages": {
    "upperBody": <number>,
    "lowerBody": <number>,
    "core": <number>,
    "fullBody": <number>
  }
}

Rules:
- "exercises" must contain ONE entry per SEGMENT (set) from the ExerciseIndex — not per unique exercise. Each set is its own entry.
- "cues" for each exercise: use the consensus cues for that exercise name. Repeat the same cues across sets of the same exercise.
- "transcript": use the full trainer transcription if available, otherwise empty string ""
- "summary": professional, specific (mention the exercises, intensity, key coaching themes)
- "trainerCues": the top 3-6 session-level priorities from the consensus
- "protocolRecommendations": the SC_COACH / consensus programming notes as a paragraph
- "emphasisPercentages": carry forward exactly from the ExerciseIndex

Return ONLY valid JSON. No markdown, no explanation.

═══════════════════════════════════════════════════════════
EXERCISE INDEX (for reference — use these IDs and timestamps)
═══════════════════════════════════════════════════════════
${JSON.stringify(exerciseIndex.segments.map(s => ({
    segmentId: s.segmentId,
    exerciseName: s.exerciseName,
    startTime: s.startTime,
    endTime: s.endTime,
    setNumber: s.setNumber,
    reps: s.movementType === 'isometric'
      ? `${s.holdTimeSeconds}s hold`
      : String((s.fullReps || 0) + (s.partialReps || 0)),
    weight: s.weight,
    setDurationSeconds: s.setDurationSeconds,
    movementType: s.movementType,
    tags: s.tags,
    bodyParts: s.bodyParts,
  })), null, 2)}`;
}

/**
 * Merge Claude's generated analysis with the raw ExerciseIndex to ensure
 * all segments are present and timestamps are accurate.
 */
function mergeWithExerciseIndex(
  generated: GeneratedSessionAnalysis,
  exerciseIndex: ExerciseIndex,
): GeneratedSessionAnalysis {
  // Build a lookup of generated exercises by segmentId
  const generatedById = new Map(
    (generated.exercises || []).map(e => [e.id, e])
  );

  // Build exercise-level cues lookup by name (for fallback)
  const cuesByName = new Map<string, string[]>();
  for (const ex of (generated.exercises || [])) {
    if (!cuesByName.has(ex.name)) cuesByName.set(ex.name, ex.cues);
  }

  // Rebuild exercises from ExerciseIndex segments (source of truth for timestamps)
  const exercises: GeneratedExercise[] = exerciseIndex.segments.map(seg => {
    const gen = generatedById.get(seg.segmentId);
    const reps = seg.movementType === 'isometric'
      ? `${seg.holdTimeSeconds ?? 0}s hold`
      : String((seg.fullReps || 0) + (seg.partialReps || 0));

    return {
      id: seg.segmentId,
      name: seg.exerciseName,
      startTime: seg.startTime,
      endTime: seg.endTime,
      reps: gen?.reps ?? reps,
      weight: gen?.weight ?? seg.weight,
      duration: gen?.duration ?? `${seg.setDurationSeconds}s`,
      cues: gen?.cues ?? cuesByName.get(seg.exerciseName) ?? [],
      tags: gen?.tags ?? [...seg.tags, ...seg.bodyParts, seg.movementType],
    };
  });

  return {
    exercises,
    transcript: generated.transcript ?? '',
    summary: generated.summary ?? '',
    trainerCues: generated.trainerCues ?? [],
    protocolRecommendations: generated.protocolRecommendations ?? '',
    emphasisPercentages: exerciseIndex.emphasisPercentages, // always use the source of truth
  };
}
