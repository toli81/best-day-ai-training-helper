import * as admin from 'firebase-admin';

admin.initializeApp();

// Auth triggers
export { onUserCreate } from './auth/onUserCreate';

// Storage functions (Phase 3)
export { getSignedUrl } from './storage/getSignedUrl';
export { getUploadUrl } from './storage/getUploadUrl';
export { onVideoUploaded } from './storage/onVideoUploaded';

// AI proxy (Phase 4)
export { proxyGeminiAnalysis } from './ai/proxyGeminiAnalysis';

// Library management (Phase 5)
export { addToLibrary } from './library/addToLibrary';

// Multi-Agent Analysis (Phase 1 — REP_COUNTER Gatekeeper)
// Multi-Agent Analysis (Phase 2 — Specialists + Consensus + Report)
export {
  onVideoUploadedDeepAnalysis,
  onAnalysisJobCreated,
  triggerDeepAnalysis,
  getExerciseIndex,
  onRepCounterComplete,
} from './agents/phase1Functions';
