/**
 * Best Day AI — Phase 2: Specialist Agents
 *
 * PT_EXPERT  — Gemini watches the video; analyses form, mechanics, injury risk
 * SC_COACH   — Gemini text-only; analyses load, volume, programming (no video needed)
 *
 * Both store their results in analysisJobs/{jobId}/agentResults/{agentId}.
 *
 * FILE: functions/src/agents/specialistAgents.ts
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';
import type { ExerciseIndex } from './repCounterAgent';

// ── Output Types ─────────────────────────────────────────────────────────────

export interface PtExpertResult {
  agentId: 'PT_EXPERT';
  model: string;
  engine: 'gemini';
  exerciseAnalyses: PtExerciseAnalysis[];
  processingTimeMs: number;
  completedAt: admin.firestore.Timestamp;
}

export interface PtExerciseAnalysis {
  exerciseName: string;
  formNotes: string[];         // specific mechanics observed
  cuesToGiveClient: string[];  // 3-5 actionable cues for the trainer to give the client
  injuryFlags: string[];       // biomechanical risks
  formGrade: 'A' | 'B' | 'C' | 'D';
}

export interface ScCoachResult {
  agentId: 'SC_COACH';
  model: string;
  engine: 'gemini';
  exerciseAnalyses: ScExerciseAnalysis[];
  sessionNotes: ScSessionNotes;
  processingTimeMs: number;
  completedAt: admin.firestore.Timestamp;
}

export interface ScExerciseAnalysis {
  exerciseName: string;
  loadAssessment: 'under-loaded' | 'optimal' | 'over-loaded';
  rpeEstimate: number;        // 1-10
  progressionNotes: string[];
  restAssessment: string;
}

export interface ScSessionNotes {
  volumeAssessment: string;
  intensityAssessment: string;
  nextSessionRecommendations: string[];
  protocolRecommendations: string;
}

// ── Gemini Schemas ────────────────────────────────────────────────────────────

const PT_EXPERT_SCHEMA = {
  type: 'object',
  properties: {
    exerciseAnalyses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          exerciseName:       { type: 'string' },
          formNotes:          { type: 'array', items: { type: 'string' } },
          cuesToGiveClient:   { type: 'array', items: { type: 'string' } },
          injuryFlags:        { type: 'array', items: { type: 'string' } },
          formGrade:          { type: 'string' },
        },
        required: ['exerciseName', 'formNotes', 'cuesToGiveClient', 'injuryFlags', 'formGrade'],
      },
    },
  },
  required: ['exerciseAnalyses'],
};

const SC_COACH_SCHEMA = {
  type: 'object',
  properties: {
    exerciseAnalyses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          exerciseName:       { type: 'string' },
          loadAssessment:     { type: 'string' },
          rpeEstimate:        { type: 'number' },
          progressionNotes:   { type: 'array', items: { type: 'string' } },
          restAssessment:     { type: 'string' },
        },
        required: ['exerciseName', 'loadAssessment', 'rpeEstimate', 'progressionNotes', 'restAssessment'],
      },
    },
    sessionNotes: {
      type: 'object',
      properties: {
        volumeAssessment:            { type: 'string' },
        intensityAssessment:         { type: 'string' },
        nextSessionRecommendations:  { type: 'array', items: { type: 'string' } },
        protocolRecommendations:     { type: 'string' },
      },
      required: [
        'volumeAssessment', 'intensityAssessment',
        'nextSessionRecommendations', 'protocolRecommendations',
      ],
    },
  },
  required: ['exerciseAnalyses', 'sessionNotes'],
};

// ── Prompt Builders ───────────────────────────────────────────────────────────

function buildPtExpertPrompt(exerciseIndex: ExerciseIndex): string {
  // Build a timestamp guide so Gemini knows exactly where to look
  const timestampGuide = exerciseIndex.segments
    .map(seg => {
      const start = formatSeconds(seg.startTime);
      const end = formatSeconds(seg.endTime);
      const reps = seg.movementType === 'isometric'
        ? `${seg.holdTimeSeconds}s hold`
        : `${(seg.fullReps || 0) + (seg.partialReps || 0)} reps`;
      const formFlag = seg.formBreakdownAtRep != null
        ? ` ⚠ form breakdown at rep ${seg.formBreakdownAtRep}`
        : '';
      return `  [${start}–${end}] ${seg.exerciseName} — Set ${seg.setNumber} — ${reps} @ ${seg.weight}${formFlag}`;
    })
    .join('\n');

  const flaggedNote = exerciseIndex.flaggedForReview.length > 0
    ? `\n\nFLAGGED FOR REVIEW by indexer: ${exerciseIndex.flaggedForReview.join(', ')}`
    : '';

  return `You are an expert Physical Therapist and movement specialist working inside a personal training video analysis system.

A video indexing AI (REP_COUNTER) has already watched this session and produced a structured exercise index. You must now watch the same video and provide deep FORM ANALYSIS for each exercise the client performed.

═══════════════════════════════════════════════════════════
EXERCISE TIMESTAMP GUIDE — Focus on these windows only
═══════════════════════════════════════════════════════════
${timestampGuide}${flaggedNote}

═══════════════════════════════════════════════════════════
YOUR MISSION
═══════════════════════════════════════════════════════════

For EACH exercise listed above, watch the corresponding video window and provide:

1. FORM NOTES — Specific observations about mechanics (e.g. "Knee tracks inward on the eccentric phase of Squat Set 2 rep 4", "Lumbar extension maintained throughout Romanian Deadlift Set 1"). Be precise about WHICH set and rep if relevant.

2. CUES TO GIVE CLIENT — 3-5 actionable, short coaching cues the trainer should communicate to the client during or after this exercise. These should be corrective (if form issues exist) or reinforcing (if form is good). Write them as direct instructions to the client (e.g. "Drive your knees out on the way down", "Brace your core before each rep").

3. INJURY FLAGS — Any movements that create joint stress, compensation patterns, or injury risk. If none, return an empty array.

4. FORM GRADE — A (excellent), B (good), C (needs work), D (significant issues).

═══════════════════════════════════════════════════════════
CRITICAL RULES
═══════════════════════════════════════════════════════════
- CLIENT ONLY. Ignore trainer demonstrations.
- One analysis object per UNIQUE exercise (not per set). Combine observations from all sets.
- Be specific. "Knees caving at bottom of squat" is useful. "Form could be better" is not.
- If a set is obscured or off-camera, note it in formNotes and reduce your confidence.
- Never fabricate observations for segments you cannot clearly see.

Return ONLY valid JSON matching the schema. No markdown, no preamble.`;
}

function buildScCoachPrompt(exerciseIndex: ExerciseIndex): string {
  // Summarise the session data as structured text for Claude
  const summaryText = exerciseIndex.exerciseSummary.map(ex => {
    const segs = exerciseIndex.segments.filter(s =>
      ex.segmentIds.includes(s.segmentId)
    );
    const weights = [...new Set(segs.map(s => s.weight).filter(Boolean))];
    const restTimes = segs
      .map(s => s.restAfterSeconds)
      .filter((r): r is number => r != null);
    const avgRest = restTimes.length > 0
      ? Math.round(restTimes.reduce((a, b) => a + b, 0) / restTimes.length)
      : null;
    const tempos = segs.map(s => s.tempo).filter(Boolean);

    return `
Exercise: ${ex.exerciseName}
  Sets: ${ex.totalSets}
  Total Reps: ${ex.totalReps ?? 'N/A (isometric)'}
  Total Hold Time: ${ex.totalHoldTime != null ? `${ex.totalHoldTime}s` : 'N/A'}
  Weight(s): ${weights.join(', ') || 'bodyweight/unloaded'}
  Avg Rest Between Sets: ${avgRest != null ? `${avgRest}s` : 'unknown'}
  Avg Confidence: ${(ex.averageConfidence * 100).toFixed(0)}%
  Tempo (eccentric/pause/concentric): ${tempos.length > 0 ? tempos.map(t => t!.join('-')).join(', ') : 'not recorded'}
  Movement Type: ${segs[0]?.movementType || 'unknown'}
  Form Breakdown (set/rep): ${segs.map((s, i) => s.formBreakdownAtRep != null ? `Set ${i + 1} rep ${s.formBreakdownAtRep}` : null).filter(Boolean).join(', ') || 'none'}`;
  }).join('\n');

  return `You are an expert Strength & Conditioning Coach working inside a personal training session analysis system.

A video indexing AI has captured structured data from this training session. Analyse the session data below and provide programming insights. You do NOT need to watch the video — all the quantitative data you need is here.

═══════════════════════════════════════════════════════════
SESSION DATA
═══════════════════════════════════════════════════════════
Total Session Duration: ${Math.round(exerciseIndex.totalSessionDuration / 60)} minutes
Active Time: ${Math.round(exerciseIndex.totalActiveTime / 60)} minutes
Rest Time: ${Math.round(exerciseIndex.totalRestTime / 60)} minutes
Work:Rest Ratio: ${exerciseIndex.totalActiveTime > 0 ? (exerciseIndex.totalActiveTime / Math.max(exerciseIndex.totalRestTime, 1)).toFixed(2) : 'N/A'}
Body Emphasis: Upper ${exerciseIndex.emphasisPercentages.upperBody}% | Lower ${exerciseIndex.emphasisPercentages.lowerBody}% | Core ${exerciseIndex.emphasisPercentages.core}% | Full Body ${exerciseIndex.emphasisPercentages.fullBody}%
${summaryText}

═══════════════════════════════════════════════════════════
YOUR MISSION
═══════════════════════════════════════════════════════════

For EACH exercise, provide:
1. LOAD ASSESSMENT — "under-loaded", "optimal", or "over-loaded" based on the rep range, weight, and rep quality (form breakdown indicates over-loading)
2. RPE ESTIMATE — Estimated Rate of Perceived Exertion (1-10) based on rep counts, form breakdown point, and rest times
3. PROGRESSION NOTES — Specific, actionable suggestions for next session (e.g. "Increase weight by 5% given zero form breakdown", "Reduce to 3 sets; form broke down in set 2")
4. REST ASSESSMENT — Was rest adequate, too short, or excessive?

For the OVERALL SESSION:
- Volume assessment (total sets × reps relative to the session goal)
- Intensity assessment (overall load and effort)
- 2-3 concrete next-session recommendations
- Protocol recommendations (training frequency, split, periodization notes if apparent)

Return ONLY valid JSON matching the schema. No markdown, no preamble.`;
}

function formatSeconds(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── PT_EXPERT Agent ───────────────────────────────────────────────────────────

export async function runPtExpert(
  jobId: string,
  videoBase64: string,
  videoMimeType: string,
  exerciseIndex: ExerciseIndex,
): Promise<void> {
  const startTime = Date.now();
  const db = admin.firestore();
  const apiKey = functions.config().gemini?.api_key || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

  const ai = new GoogleGenAI({ apiKey });
  const model = 'gemini-2.5-flash';

  console.log(`[PT_EXPERT] Starting for job ${jobId} — ${exerciseIndex.segments.length} segments`);

  try {
    const prompt = buildPtExpertPrompt(exerciseIndex);

    const response = await ai.models.generateContent({
      model,
      contents: [
        { inlineData: { data: videoBase64, mimeType: videoMimeType } },
        { text: prompt },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: PT_EXPERT_SCHEMA,
      },
    });

    const text = response.text ?? '';
    if (!text) throw new Error('PT_EXPERT: Gemini returned empty response');

    let parsed: { exerciseAnalyses: PtExerciseAnalysis[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error('[PT_EXPERT] Parse failed, raw:', text.substring(0, 400));
      throw new Error('PT_EXPERT: Gemini returned invalid JSON');
    }

    const result: PtExpertResult = {
      agentId: 'PT_EXPERT',
      model,
      engine: 'gemini',
      exerciseAnalyses: parsed.exerciseAnalyses || [],
      processingTimeMs: Date.now() - startTime,
      completedAt: admin.firestore.Timestamp.now(),
    };

    await db.collection('analysisJobs').doc(jobId)
      .collection('agentResults').doc('PT_EXPERT')
      .set(result);

    console.log(`[PT_EXPERT] Done for job ${jobId} — ${result.exerciseAnalyses.length} analyses in ${result.processingTimeMs}ms`);
  } catch (err: any) {
    console.error(`[PT_EXPERT] Failed for job ${jobId}:`, err.message);
    // Store error but don't throw — specialists are non-blocking
    await db.collection('analysisJobs').doc(jobId)
      .collection('agentResults').doc('PT_EXPERT')
      .set({
        agentId: 'PT_EXPERT',
        engine: 'gemini',
        error: err.message,
        exerciseAnalyses: [],
        processingTimeMs: Date.now() - startTime,
        completedAt: admin.firestore.Timestamp.now(),
      });
  }
}

// ── SC_COACH Agent ────────────────────────────────────────────────────────────

export async function runScCoach(
  jobId: string,
  exerciseIndex: ExerciseIndex,
): Promise<void> {
  const startTime = Date.now();
  const db = admin.firestore();
  const apiKey = functions.config().gemini?.api_key || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

  const ai = new GoogleGenAI({ apiKey });
  const model = 'gemini-2.5-flash';

  console.log(`[SC_COACH] Starting for job ${jobId} — text-only analysis`);

  try {
    const prompt = buildScCoachPrompt(exerciseIndex);

    const response = await ai.models.generateContent({
      model,
      contents: [{ text: prompt }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: SC_COACH_SCHEMA,
      },
    });

    const text = response.text ?? '';
    if (!text) throw new Error('SC_COACH: Gemini returned empty response');

    let parsed: { exerciseAnalyses: ScExerciseAnalysis[]; sessionNotes: ScSessionNotes };
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error('[SC_COACH] Parse failed, raw:', text.substring(0, 400));
      throw new Error('SC_COACH: Gemini returned invalid JSON');
    }

    const result: ScCoachResult = {
      agentId: 'SC_COACH',
      model,
      engine: 'gemini',
      exerciseAnalyses: parsed.exerciseAnalyses || [],
      sessionNotes: parsed.sessionNotes || {
        volumeAssessment: '',
        intensityAssessment: '',
        nextSessionRecommendations: [],
        protocolRecommendations: '',
      },
      processingTimeMs: Date.now() - startTime,
      completedAt: admin.firestore.Timestamp.now(),
    };

    await db.collection('analysisJobs').doc(jobId)
      .collection('agentResults').doc('SC_COACH')
      .set(result);

    console.log(`[SC_COACH] Done for job ${jobId} — ${result.exerciseAnalyses.length} analyses in ${result.processingTimeMs}ms`);
  } catch (err: any) {
    console.error(`[SC_COACH] Failed for job ${jobId}:`, err.message);
    await db.collection('analysisJobs').doc(jobId)
      .collection('agentResults').doc('SC_COACH')
      .set({
        agentId: 'SC_COACH',
        engine: 'gemini',
        error: err.message,
        exerciseAnalyses: [],
        sessionNotes: {
          volumeAssessment: '',
          intensityAssessment: '',
          nextSessionRecommendations: [],
          protocolRecommendations: '',
        },
        processingTimeMs: Date.now() - startTime,
        completedAt: admin.firestore.Timestamp.now(),
      });
  }
}
