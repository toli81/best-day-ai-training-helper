import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrainingSession } from '../types';
import { subscribeSessions } from '../services/firestoreService';
import { getVideo } from '../services/storageService';

/** Race a promise against a timeout — resolves null on timeout instead of rejecting */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Real-time listener for the current trainer's sessions in Firestore.
 * Hydrates each session with a local video object URL if available in IndexedDB.
 */
export function useFirestoreSessions(trainerId: string | undefined) {
  const [sessions, setSessions] = useState<TrainingSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!trainerId) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    loadedRef.current = false;

    // Safety: 15-second timeout prevents infinite loading spinner
    const loadTimeout = setTimeout(() => {
      if (!loadedRef.current) {
        setLoading(false);
        setError('Loading took too long. Check your connection and tap Retry.');
      }
    }, 15000);

    const unsubscribe = subscribeSessions(
      trainerId,
      async (firestoreSessions) => {
        // Hydrate with local video blobs from IndexedDB (5s timeout per video)
        const hydrated = await Promise.all(
          firestoreSessions.map(async (session) => {
            try {
              const blob = await withTimeout(getVideo(session.id), 5000);
              if (blob) {
                return { ...session, videoUrl: URL.createObjectURL(blob) };
              }
            } catch {
              // Video not in local cache -- that's fine, will use signed URL later
            }
            return session;
          })
        );
        setSessions(hydrated);
        loadedRef.current = true;
        clearTimeout(loadTimeout);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('[useFirestoreSessions] Subscription error:', err);
        loadedRef.current = true;
        clearTimeout(loadTimeout);
        setError(err.message || 'Failed to load sessions');
        setLoading(false);
      },
    );

    return () => {
      unsubscribe();
      clearTimeout(loadTimeout);
    };
  }, [trainerId, retryCount]);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);

  return { sessions, loading, error, retry };
}
