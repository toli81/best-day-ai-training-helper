
export type SessionMode = 'clip' | 'workout30' | 'workout60';

export type AnalysisJobStatus =
  | 'pending'
  | 'rep_counter_running'
  | 'rep_counter_complete'
  | 'specialists_running'
  | 'consensus_running'
  | 'report_generating'
  | 'draft_ready'
  | 'reviewed'
  | 'failed';

export interface Exercise {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  reps: number | string;
  weight?: string;
  duration?: string;
  cues: string[];
  tags: string[];
}

export interface EmphasisPercentages {
  upperBody: number;
  lowerBody: number;
  core: number;
  fullBody: number;
}

export interface SessionAnalysis {
  exercises: Exercise[];
  transcript: string;
  summary: string;
  trainerCues: string[];
  protocolRecommendations: string;
  emphasisPercentages: EmphasisPercentages;
}

export type SyncStatus = 'local' | 'uploading' | 'synced' | 'failed';

export interface TrainingSession {
  id: string;
  trainerId?: string;
  clientName: string;
  date: string;
  duration: number; // Duration in seconds
  videoUrl?: string;
  videoBlob?: Blob;
  analysis?: SessionAnalysis;
  tags: string[];
  snapshotCount?: number;
  mode: SessionMode;
  status?: 'complete' | 'failed' | 'processing';
  error?: string;
  syncStatus?: SyncStatus;
  videoPath?: string; // GCS path
  analysisJobId?: string;
  analysisStatus?: AnalysisJobStatus;
  driveSync?: {
    status: 'synced' | 'pending' | 'failed';
    folderLink?: string;
    lastAttempt?: string;
  };
}

export type ViewState = 'dashboard' | 'recorder' | 'details' | 'library';

// --- Cloud / Multi-trainer types ---

export interface Trainer {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string | null;
  createdAt: string;
  settings: TrainerSettings;
}

export interface TrainerSettings {
  defaultMode: SessionMode;
  autoSyncEnabled: boolean;
}

export interface Client {
  id: string;
  name: string;
  createdAt: string;
  notes: string;
  tags: string[];
  isActive: boolean;
  linkedUserId: string | null; // future: link to client's Firebase Auth UID
  email: string | null;
}

export interface LibraryExercise {
  id: string;
  name: string;
  nameLower: string;
  reps: number | string;
  weight: string | null;
  duration: string | null;
  cues: string[];
  tags: string[];
  tagsLower: string[];
  startTime: number;
  endTime: number;
  sourceSessionId: string;
  sourceTrainerId: string;
  sourceTrainerName: string;
  clientName: string;
  sessionDate: string;
  clipPath: string | null;
  clipUrl: string | null;
  videoPath: string;
  addedAt: string;
  addedBy: string;
  searchTerms: string[];
}

export interface SyncTask {
  id: string;
  sessionId: string;
  type: 'video_upload' | 'metadata_sync';
  status: 'pending' | 'in_progress' | 'failed';
  retryCount: number;
  lastAttempt: number | null;
  gcsPath: string;
  blobKey: string;
}
