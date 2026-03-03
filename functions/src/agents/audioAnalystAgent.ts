/**
 * Best Day AI — Phase 2: Audio Analyst Agent
 *
 * AUDIO_ANALYST — Gemini listens to the video audio track.
 *
 * Behaviour:
 *   - Assesses audio quality FIRST
 *   - If music / heavy background noise → marks as unusable, returns no cues
 *   - If trainer voice is audible → transcribes session, extracts verbal cues,
 *     matches cues to exercises by timestamp
 *
 * CONSENSUS will ignore this agent's output entirely if useable === false.
 *
 * FILE: functions/src/agents/audioAnalystAgent.ts
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';
import type { ExerciseIndex } from './repCounterAgent';

// ── Output Types ─────────────────────────────────────────────────────────────

export type AudioQuality = 'clear' | 'partial' | 'noisy' | 'music' | 'silent';

export interface AudioCue {
  exerciseName: string;  // matched to ExerciseIndex by timestamp proximity
  timestamp: number;     // seconds into the video
  cue: string;           // what the trainer said (verbatim or paraphrased)
}

export interface AudioAnalystResult {
  agentId: 'AUDIO_ANALYST';
  model: string;
  engine: 'gemini';
  audioQuality: AudioQuality;
  useable: boolean;
  fullTranscription: string | null;
  exerciseCues: AudioCue[] | null;
  sessionSummary: string | null;
  processingTimeMs: number;
  completedAt: admin.firestore.Timestamp;
}

// ── Gemini Schema ─────────────────────────────────────────────────────────────

const AUDIO_ANALYST_SCHEMA = {
  type: 'object',
  properties: {
    audioQuality: { type: 'string' },
    useable: { type: 'boolean' },
    fullTranscription: { type: 'string' },
    exerciseCues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          exerciseName: { type: 'string' },
          timestamp:    { type: 'number' },
          cue:          { type: 'string' },
        },
        required: ['exerciseName', 'timestamp', 'cue'],
      },
    },
    sessionSummary: { type: 'string' },
  },
  required: ['audioQuality', 'useable'],
};

// ── Prompt Builder ────────────────────────────────────────────────────────────

function buildAudioPrompt(exerciseIndex: ExerciseIndex): string {
  const exerciseWindows = exerciseIndex.segments
    .map(seg => {
      const start = formatSeconds(seg.startTime);
      const end = formatSeconds(seg.endTime);
      return `  [${start}–${end}] ${seg.exerciseName} (Set ${seg.setNumber})`;
    })
    .join('\n');

  return `You are an AUDIO ANALYST for a personal training session analysis system.

Your job is to listen to the audio track of this session recording and extract coaching information spoken by the TRAINER.

═══════════════════════════════════════════════════════════
EXERCISE WINDOWS (for timestamp context)
═══════════════════════════════════════════════════════════
${exerciseWindows}

═══════════════════════════════════════════════════════════
STEP 1: ASSESS AUDIO QUALITY FIRST
═══════════════════════════════════════════════════════════

Classify audio quality as one of:
- "clear"   — Trainer's voice is clearly audible, minimal background noise
- "partial" — Trainer's voice is audible but background noise is present; some words may be unclear
- "noisy"   — Background noise (gym equipment, crowd) makes speech very difficult to transcribe accurately
- "music"   — Background music is playing and dominates the audio; speech is largely obscured
- "silent"  — No meaningful audio; microphone was off or audio track is empty

Set "useable" to:
- TRUE  → if audioQuality is "clear" or "partial"
- FALSE → if audioQuality is "noisy", "music", or "silent"

If useable is FALSE: Return only audioQuality and useable=false. Set all other fields to null. Do NOT attempt transcription.

═══════════════════════════════════════════════════════════
STEP 2 (only if useable=true): TRANSCRIBE AND EXTRACT CUES
═══════════════════════════════════════════════════════════

1. FULL TRANSCRIPTION — Transcribe everything the TRAINER says. Include only trainer speech (not client grunts, music, or ambient noise). If a word is unclear, use [inaudible].

2. EXERCISE CUES — Extract every distinct coaching cue or instruction the trainer gave to the client. For each cue:
   - exerciseName: Match to the exercise being performed at that timestamp (use the Exercise Windows above). Use "general" if not during an exercise window.
   - timestamp: The second in the video when the cue was given
   - cue: The actual coaching instruction (verbatim or close paraphrase). Exclude generic motivational phrases like "good job" or "keep going" UNLESS they contain specific technical instruction.

3. SESSION SUMMARY — 1-3 sentence summary of what the trainer communicated overall (style, focus areas, specific coaching points made).

═══════════════════════════════════════════════════════════
CRITICAL RULES
═══════════════════════════════════════════════════════════
- TRAINER VOICE ONLY. Ignore client responses, music, equipment sounds.
- Verbal rep counting ("1, 2, 3...") is motivational, NOT a cue — do NOT include these.
- Motivational encouragements ("great work!", "you got this") are NOT coaching cues — exclude unless they include a technical point.
- If you cannot reliably transcribe a cue, omit it rather than guess.
- Be honest about audio quality. Do not force a transcription on unusable audio.

Return ONLY valid JSON matching the schema. No markdown, no preamble.`;
}

function formatSeconds(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── AUDIO_ANALYST Agent ───────────────────────────────────────────────────────

export async function runAudioAnalyst(
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

  console.log(`[AUDIO_ANALYST] Starting for job ${jobId}`);

  try {
    const prompt = buildAudioPrompt(exerciseIndex);

    const response = await ai.models.generateContent({
      model,
      contents: [
        { inlineData: { data: videoBase64, mimeType: videoMimeType } },
        { text: prompt },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: AUDIO_ANALYST_SCHEMA,
      },
    });

    const text = response.text ?? '';
    if (!text) throw new Error('AUDIO_ANALYST: Gemini returned empty response');

    let parsed: {
      audioQuality: AudioQuality;
      useable: boolean;
      fullTranscription?: string;
      exerciseCues?: AudioCue[];
      sessionSummary?: string;
    };

    try {
      parsed = JSON.parse(text);
    } catch {
      console.error('[AUDIO_ANALYST] Parse failed, raw:', text.substring(0, 400));
      throw new Error('AUDIO_ANALYST: Gemini returned invalid JSON');
    }

    const result: AudioAnalystResult = {
      agentId: 'AUDIO_ANALYST',
      model,
      engine: 'gemini',
      audioQuality: parsed.audioQuality,
      useable: parsed.useable,
      fullTranscription: parsed.useable ? (parsed.fullTranscription ?? null) : null,
      exerciseCues: parsed.useable ? (parsed.exerciseCues ?? null) : null,
      sessionSummary: parsed.useable ? (parsed.sessionSummary ?? null) : null,
      processingTimeMs: Date.now() - startTime,
      completedAt: admin.firestore.Timestamp.now(),
    };

    await db.collection('analysisJobs').doc(jobId)
      .collection('agentResults').doc('AUDIO_ANALYST')
      .set(result);

    const status = result.useable
      ? `audio useable (${result.audioQuality}), ${result.exerciseCues?.length ?? 0} cues extracted`
      : `audio NOT useable (${result.audioQuality}) — skipped`;

    console.log(`[AUDIO_ANALYST] Done for job ${jobId} — ${status} in ${result.processingTimeMs}ms`);
  } catch (err: any) {
    console.error(`[AUDIO_ANALYST] Failed for job ${jobId}:`, err.message);
    // Store a failed-but-non-blocking result
    await db.collection('analysisJobs').doc(jobId)
      .collection('agentResults').doc('AUDIO_ANALYST')
      .set({
        agentId: 'AUDIO_ANALYST',
        engine: 'gemini',
        error: err.message,
        audioQuality: 'silent' as AudioQuality,
        useable: false,
        fullTranscription: null,
        exerciseCues: null,
        sessionSummary: null,
        processingTimeMs: Date.now() - startTime,
        completedAt: admin.firestore.Timestamp.now(),
      });
  }
}
