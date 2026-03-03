/**
 * Best Day AI — Frontend Service: Deep Analysis Pipeline
 *
 * Call from your React app to trigger and monitor multi-agent analysis.
 * Pairs with the existing geminiService.ts (which handles quick analysis)
 * and the new Cloud Functions (which handle deep analysis via Gemini agents).
 *
 * FILE: services/deepAnalysisService.ts
 */

import { getFunctions, httpsCallable } from 'firebase/functions';
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { db } from './firebaseConfig';

// ── Types ───────────────────────────────────────────────────────────────────

export type AnalysisJobStatus =
  | 'pending'
  | 'rep_counter_running'
  | 'rep_counter_complete'
  | 'specialists_running'   // Phase 2
  | 'consensus_running'     // Phase 2
  | 'report_generating'     // Phase 2
  | 'draft_ready'           // Phase 2
  | 'reviewed'              // Phase 3
  | 'failed';

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

export interface ExerciseSummary {
  exerciseName: string;
  segmentIds: string[];
  totalSets: number;
  totalReps: number | null;
  totalHoldTime: number | null;
  averageConfidence: number;
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

// ── Trigger Deep Analysis ───────────────────────────────────────────────────

interface TriggerResponse {
  jobId: string;
  segmentsFound: number;
  uniqueExercises: number;
  confidence: number;
  flaggedForReview: string[];
  excludedDemonstrations: number;
}

/**
 * Manually trigger deep analysis on an existing session.
 * Returns summary of what was found.
 */
export async function triggerDeepAnalysis(sessionId: string): Promise<TriggerResponse> {
  const functions = getFunctions();
  const fn = httpsCallable<{ sessionId: string }, TriggerResponse>(
    functions, 'triggerDeepAnalysis'
  );
  const result = await fn({ sessionId });
  return result.data;
}

// ── Get Exercise Index ──────────────────────────────────────────────────────

interface IndexResponse {
  jobId: string;
  status: AnalysisJobStatus;
  exerciseIndex: ExerciseIndex | null;
  error: string | null;
}

/**
 * Fetch the completed exercise index for a job.
 */
export async function getExerciseIndex(jobId: string): Promise<IndexResponse> {
  const functions = getFunctions();
  const fn = httpsCallable<{ jobId: string }, IndexResponse>(
    functions, 'getExerciseIndex'
  );
  const result = await fn({ jobId });
  return result.data;
}

// ── Real-time Status Subscription ───────────────────────────────────────────

interface JobUpdate {
  status: AnalysisJobStatus;
  exerciseIndex?: ExerciseIndex;
  error?: string;
}

/**
 * Subscribe to real-time updates on an analysis job.
 * Returns an unsubscribe function.
 *
 * Usage:
 *   const unsub = subscribeToAnalysisJob(jobId, (update) => {
 *     setStatus(update.status);
 *     if (update.exerciseIndex) setIndex(update.exerciseIndex);
 *   });
 *   // Later: unsub();
 */
export function subscribeToAnalysisJob(
  jobId: string,
  callback: (update: JobUpdate) => void
): Unsubscribe {
  const jobRef = doc(db, 'analysisJobs', jobId);
  return onSnapshot(jobRef, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    callback({
      status: data.status as AnalysisJobStatus,
      exerciseIndex: data.exerciseIndex,
      error: data.error,
    });
  });
}

// ── Status Display Helpers ──────────────────────────────────────────────────

export function getStatusLabel(status: AnalysisJobStatus): string {
  const labels: Record<AnalysisJobStatus, string> = {
    pending: 'Queued for analysis...',
    rep_counter_running: 'Indexing exercises...',
    rep_counter_complete: 'Exercise index ready',
    specialists_running: 'Specialists analyzing...',
    consensus_running: 'Building consensus...',
    report_generating: 'Generating report...',
    draft_ready: 'Report ready for review',
    reviewed: 'Review complete',
    failed: 'Analysis failed',
  };
  return labels[status] || status;
}

export function getStatusProgress(status: AnalysisJobStatus): number {
  const progress: Record<AnalysisJobStatus, number> = {
    pending: 0,
    rep_counter_running: 20,
    rep_counter_complete: 40,
    specialists_running: 60,
    consensus_running: 75,
    report_generating: 90,
    draft_ready: 100,
    reviewed: 100,
    failed: 0,
  };
  return progress[status] || 0;
}
