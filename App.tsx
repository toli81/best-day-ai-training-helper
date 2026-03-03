import React, { useState, useEffect, useCallback, useRef } from 'react';
import Layout from './components/Layout';
import Recorder from './components/Recorder';
import ExerciseLibrary from './components/ExerciseLibrary';
import { TrainingSession, ViewState, SessionMode, Exercise, SessionAnalysis } from './types';
import { analyzeVideoClip, analyzeSnapshotAudit, blobToBase64 } from './services/geminiService';
import { saveVideo, getVideo, deleteVideo, getAllSessionIds } from './services/storageService';
import { useAuth } from './hooks/useAuth';
import { useFirestoreSessions } from './hooks/useFirestoreSessions';
import { saveSession, updateSession, deleteSession as deleteFirestoreSession, ensureClient } from './services/firestoreService';
import { enqueue as enqueueSyncTask, init as initSyncService, registerCallbacks } from './services/syncService';
import { addExerciseToLibrary } from './services/exerciseLibraryService';
import { hasLocalData } from './services/migrationService';
import MigrationDialog from './components/MigrationDialog';
import { getStatusLabel, getStatusProgress } from './services/deepAnalysisService';
import type { AnalysisJobStatus } from './services/deepAnalysisService';

const App: React.FC = () => {
  const { user } = useAuth();
  const trainerId = user?.uid;

  const [view, setView] = useState<ViewState>('dashboard');
  const [isRecording, setIsRecording] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingExerciseJump, setPendingExerciseJump] = useState<Exercise | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ used: number; total: number; percent: number } | null>(null);

  // Selection state for bulk actions
  const [isManageMode, setIsManageMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());

  // Transcription toggles for dashboard
  const [expandedTranscripts, setExpandedTranscripts] = useState<Record<string, boolean>>({});

  // Local state for editing exercise names within the details view
  const [editingExerciseId, setEditingExerciseId] = useState<string | null>(null);
  const [tempExerciseName, setTempExerciseName] = useState('');

  const videoPlayerRef = useRef<HTMLVideoElement>(null);

  // Firestore real-time sessions (replaces localStorage)
  const { sessions: firestoreSessions, loading: sessionsLoading } = useFirestoreSessions(trainerId);

  // Local override for optimistic UI (set briefly during saves, cleared by Firestore listener)
  const [localSessions, setLocalSessions] = useState<TrainingSession[] | null>(null);
  const sessions = localSessions ?? firestoreSessions;
  const setSessions = setLocalSessions;

  // Clear local overrides when Firestore catches up
  useEffect(() => {
    if (firestoreSessions.length > 0 || !sessionsLoading) {
      setLocalSessions(null);
    }
  }, [firestoreSessions, sessionsLoading]);

  const updateStorageEstimate = useCallback(async () => {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      if (estimate.usage !== undefined && estimate.quota !== undefined) {
        const usedMB = Math.round(estimate.usage / (1024 * 1024));
        const totalMB = Math.round(estimate.quota / (1024 * 1024));
        const percent = Math.min(100, Math.round((estimate.usage / estimate.quota) * 100));
        setStorageInfo({ used: usedMB, total: totalMB, percent });
      }
    }
  }, []);

  useEffect(() => {
    updateStorageEstimate();
    const interval = setInterval(updateStorageEstimate, 30000);
    return () => clearInterval(interval);
  }, [updateStorageEstimate]);

  // Upload progress state: sessionId -> percent (0-100) or 'synced'/'failed'
  const [uploadProgress, setUploadProgress] = useState<Record<string, number | 'synced' | 'failed'>>({});

  // Migration dialog: show once on first login if local data exists
  const [showMigration, setShowMigration] = useState(false);
  useEffect(() => {
    if (trainerId && hasLocalData() && firestoreSessions.length === 0 && !sessionsLoading) {
      setShowMigration(true);
    }
  }, [trainerId, firestoreSessions.length, sessionsLoading]);

  // Init sync service on trainer login
  useEffect(() => {
    if (!trainerId) return;
    registerCallbacks(
      (sessionId, percent) => setUploadProgress(prev => ({ ...prev, [sessionId]: percent })),
      (sessionId, status) => {
        setUploadProgress(prev => ({ ...prev, [sessionId]: status }));
        if (status === 'synced') {
          // clean up progress indicator after a short delay
          setTimeout(() => setUploadProgress(prev => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
          }), 3000);
        }
      }
    );
    initSyncService(trainerId).catch(console.error);
  }, [trainerId]);

  // Rescue Utility: find local videos not tracked in Firestore
  const rescueOrphanedSessions = async () => {
    try {
      const allIds = await getAllSessionIds();
      const manifestIds = new Set(sessions.map(s => s.id));
      const orphans = allIds.filter(id => !manifestIds.has(id));

      if (orphans.length === 0) {
        alert("No orphaned sessions found. Your data is in sync.");
        return;
      }

      if (window.confirm(`Found ${orphans.length} video(s) not in your session list. Restore them?`)) {
        const rescued: TrainingSession[] = await Promise.all(orphans.map(async (id) => {
          const blob = await getVideo(id);
          const s: TrainingSession = {
            id,
            trainerId: trainerId || undefined,
            clientName: 'Rescued Client',
            date: new Date(parseInt(id.split('-')[1]) || Date.now()).toISOString(),
            duration: 0,
            tags: ['Rescued'],
            videoUrl: blob ? URL.createObjectURL(blob) : undefined,
            mode: 'clip',
            status: 'failed',
            syncStatus: 'local',
            error: 'Session was recovered from deep storage. AI analysis missing.'
          };
          if (trainerId) await saveSession(trainerId, s).catch(console.error);
          return s;
        }));
        setSessions([...rescued, ...sessions]);
        updateStorageEstimate();
      }
    } catch (e: any) {
      console.error("Rescue failed", e);
    }
  };

  // Handle jumping to exercise after view switch
  useEffect(() => {
    if (view === 'details' && pendingExerciseJump && videoPlayerRef.current) {
      const jump = () => {
        if (videoPlayerRef.current) {
          videoPlayerRef.current.currentTime = pendingExerciseJump.startTime;
          videoPlayerRef.current.play();
          videoPlayerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setPendingExerciseJump(null);
        }
      };

      if (videoPlayerRef.current.readyState >= 2) {
        jump();
      } else {
        videoPlayerRef.current.addEventListener('loadeddata', jump, { once: true });
      }
    }
  }, [view, pendingExerciseJump]);

  const performAnalysis = async (session: TrainingSession, blob: Blob, snapshots: string[]) => {
    try {
      let analysis: SessionAnalysis;
      const fileSizeMB = blob.size / (1024 * 1024);
      console.log(`[Analysis] Starting — mode: ${session.mode}, size: ${fileSizeMB.toFixed(1)} MB, snapshots: ${snapshots.length}`);

      // If we have pre-extracted snapshots (e.g. uploaded video), skip the slow
      // full-video base64 encoding and go straight to snapshot analysis.
      if (snapshots.length >= 3) {
        console.log('[Analysis] Using pre-extracted snapshots…');
        analysis = await analyzeSnapshotAudit(snapshots, session.mode === 'clip');
        console.log('[Analysis] Snapshot audit complete');
      } else if (session.mode === 'clip' && fileSizeMB < 18) {
        try {
          console.log('[Analysis] Encoding video to base64…');
          const base64 = await blobToBase64(blob);
          console.log('[Analysis] Base64 done, calling Gemini video analysis…');
          analysis = await analyzeVideoClip(base64, blob.type);
          console.log('[Analysis] Video analysis complete');
        } catch (e: any) {
          console.warn('[Analysis] Video analysis failed, falling back to snapshots:', e.message);
          analysis = await analyzeSnapshotAudit(snapshots, true);
          console.log('[Analysis] Snapshot fallback complete');
        }
      } else {
        console.log('[Analysis] Using snapshot audit path…');
        analysis = await analyzeSnapshotAudit(snapshots, session.mode === 'clip');
        console.log('[Analysis] Snapshot audit complete');
      }

      const updatedFields = {
        analysis,
        status: 'complete' as const,
        tags: Array.from(new Set(analysis.exercises.flatMap(ex => ex.tags)))
      };

      // Update local UI immediately — don't await Firestore so it can't block the loading state
      setSessions(prev => prev ? prev.map(s => s.id === session.id ? { ...s, ...updatedFields } : s) : prev);

      // Firestore write — then auto-share all exercises to the library
      if (trainerId) {
        updateSession(trainerId, session.id, updatedFields)
          .then(() => {
            // Auto-add all exercises to the shared library (fire-and-forget)
            // Cloud function reads session from Firestore, so updateSession must finish first
            analysis.exercises.forEach(ex => {
              addExerciseToLibrary(session.id, ex.id).catch(err =>
                console.warn(`[Auto-share] Failed for ${ex.id}:`, err.message)
              );
            });
          })
          .catch(console.error);
      }

    } catch (err: any) {
      console.error("Analysis background error:", err);
      const errorMsg = err.message || (typeof err === 'string' ? err : JSON.stringify(err)) || "AI analysis failed";

      const failedFields = { status: 'failed' as const, error: errorMsg };

      // Update local UI immediately — don't await Firestore so it can't block the loading state
      setSessions(prev => prev ? prev.map(s => s.id === session.id ? { ...s, ...failedFields } : s) : prev);

      // Firestore write is fire-and-forget
      if (trainerId) {
        updateSession(trainerId, session.id, failedFields).catch(console.error);
      }
    }
  };

  const handleSessionComplete = async (blob: Blob, clientName: string, mode: SessionMode, snapshots: string[], duration: number) => {
    setIsAnalyzing(true);
    setError(null);
    const sessionId = `sess-${Date.now()}`;

    try {
      const resolvedClientName = clientName || 'Client';

      const newSession: TrainingSession = {
        id: sessionId,
        trainerId: trainerId || undefined,
        clientName: resolvedClientName,
        date: new Date().toISOString(),
        duration,
        tags: [],
        videoUrl: URL.createObjectURL(blob),
        snapshotCount: snapshots.length,
        mode,
        status: 'processing',
        syncStatus: 'local',
      };

      // Update UI immediately — nothing blocks the dashboard from showing
      setSessions(prev => [newSession, ...(prev || [])]);
      setView('dashboard');

      // All storage/network writes are fire-and-forget
      saveVideo(sessionId, blob).catch(console.error);
      updateStorageEstimate().catch(console.error);
      if (trainerId) {
        saveSession(trainerId, newSession).catch(console.error);
        ensureClient(trainerId, resolvedClientName).catch(console.error);
        enqueueSyncTask(trainerId, sessionId, sessionId).catch(console.error);
      }

      // Run AI analysis — hard 70s safety net so loading ALWAYS clears
      await Promise.race([
        performAnalysis(newSession, blob, snapshots),
        new Promise<void>(resolve => setTimeout(resolve, 70_000))
      ]);

    } catch (err: any) {
      console.error("Critical session save error:", err);
      const errorMsg = err.message || (typeof err === 'string' ? err : JSON.stringify(err)) || "Failed to save video";
      setError(`Failed to save video: ${errorMsg}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleRetryAnalysis = async (session: TrainingSession) => {
    const blob = await getVideo(session.id);
    if (!blob) {
      alert("Video file missing from local storage. Cannot retry analysis.");
      return;
    }
    const retryFields = { status: 'processing' as const, error: undefined };
    setSessions(sessions.map(s => s.id === session.id ? { ...s, ...retryFields } : s));
    if (trainerId) updateSession(trainerId, session.id, retryFields).catch(console.error);
    await performAnalysis(session, blob, []);
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Delete this session permanently? This removes all associated videos and technical data.')) {
      await deleteVideo(id);
      if (trainerId) {
        await deleteFirestoreSession(trainerId, id).catch(console.error);
      }
      setSessions(prev => prev ? prev.filter(s => s.id !== id) : prev);
      if (currentSessionId === id) setView('dashboard');
      setSelectedSessionIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      updateStorageEstimate();
    }
  };

  const handleBulkDelete = async () => {
    const count = selectedSessionIds.size;
    if (window.confirm(`Delete ${count} sessions permanently? This action cannot be undone.`)) {
      const idsToDelete: string[] = Array.from(selectedSessionIds);
      await Promise.all(idsToDelete.map(async (id) => {
        await deleteVideo(id);
        if (trainerId) {
          await deleteFirestoreSession(trainerId, id).catch(console.error);
        }
      }));
      setSessions(prev => prev ? prev.filter(s => !selectedSessionIds.has(s.id)) : prev);
      setSelectedSessionIds(new Set());
      setIsManageMode(false);
      if (currentSessionId && selectedSessionIds.has(currentSessionId)) {
        setView('dashboard');
        setCurrentSessionId(null);
      }
      updateStorageEstimate();
    }
  };

  const toggleSessionSelection = (id: string) => {
    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllSessions = () => {
    setSelectedSessionIds(new Set(sessions.map(s => s.id)));
  };

  const deselectAllSessions = () => {
    setSelectedSessionIds(new Set());
  };

  const playExerciseClip = (exercise: Exercise) => {
    if (videoPlayerRef.current) {
      videoPlayerRef.current.currentTime = exercise.startTime;
      videoPlayerRef.current.play();
      videoPlayerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleViewExerciseFromLibrary = (sessionId: string, exercise: Exercise) => {
    setCurrentSessionId(sessionId);
    setPendingExerciseJump(exercise);
    setView('details');
  };

  const handleUpdateGlobalTag = (oldTag: string, newTag: string) => {
    const updated = (firestoreSessions.length > 0 ? firestoreSessions : (localSessions || [])).map(session => ({
      ...session,
      tags: Array.from(new Set(session.tags.map(t => t === oldTag ? newTag : t))),
      analysis: session.analysis ? {
        ...session.analysis,
        exercises: session.analysis.exercises.map(ex => ({
          ...ex,
          tags: Array.from(new Set(ex.tags.map(t => t === oldTag ? newTag : t)))
        }))
      } : session.analysis
    }));
    setSessions(updated);
    if (trainerId) {
      updated.forEach(s => updateSession(trainerId, s.id, { tags: s.tags, analysis: s.analysis }).catch(console.error));
    }
  };

  const handleDeleteGlobalTag = (tagToDelete: string) => {
    const updated = (firestoreSessions.length > 0 ? firestoreSessions : (localSessions || [])).map(session => ({
      ...session,
      tags: session.tags.filter(t => t !== tagToDelete),
      analysis: session.analysis ? {
        ...session.analysis,
        exercises: session.analysis.exercises.map(ex => ({
          ...ex,
          tags: ex.tags.filter(t => t !== tagToDelete)
        }))
      } : session.analysis
    }));
    setSessions(updated);
    if (trainerId) {
      updated.forEach(s => updateSession(trainerId, s.id, { tags: s.tags, analysis: s.analysis }).catch(console.error));
    }
  };

  const handleAddTagToExercise = (sessionId: string, exerciseId: string, tag: string) => {
    const allSessions = firestoreSessions.length > 0 ? firestoreSessions : (localSessions || []);
    const updated = allSessions.map(session => {
      if (session.id !== sessionId) return session;
      return {
        ...session,
        tags: Array.from(new Set([...session.tags, tag])),
        analysis: session.analysis ? {
          ...session.analysis,
          exercises: session.analysis.exercises.map(ex => {
            if (ex.id !== exerciseId) return ex;
            return { ...ex, tags: Array.from(new Set([...ex.tags, tag])) };
          })
        } : session.analysis
      };
    });
    setSessions(updated);
    const changed = updated.find(s => s.id === sessionId);
    if (trainerId && changed) {
      updateSession(trainerId, sessionId, { tags: changed.tags, analysis: changed.analysis }).catch(console.error);
    }
  };

  const handleRemoveTagFromExercise = (sessionId: string, exerciseId: string, tagToRemove: string) => {
    const allSessions = firestoreSessions.length > 0 ? firestoreSessions : (localSessions || []);
    const updated = allSessions.map(session => {
      if (session.id !== sessionId) return session;
      const updatedExercises = session.analysis?.exercises.map(ex => {
        if (ex.id !== exerciseId) return ex;
        return { ...ex, tags: ex.tags.filter(t => t !== tagToRemove) };
      });
      const allNewExerciseTags = Array.from(new Set(updatedExercises?.flatMap(e => e.tags) || []));
      return {
        ...session,
        tags: allNewExerciseTags,
        analysis: session.analysis ? { ...session.analysis, exercises: updatedExercises || [] } : session.analysis
      };
    });
    setSessions(updated);
    const changed = updated.find(s => s.id === sessionId);
    if (trainerId && changed) {
      updateSession(trainerId, sessionId, { tags: changed.tags, analysis: changed.analysis }).catch(console.error);
    }
  };

  const handleUpdateExerciseName = (sessionId: string, exerciseId: string, newName: string) => {
    const allSessions = firestoreSessions.length > 0 ? firestoreSessions : (localSessions || []);
    const updated = allSessions.map(session => {
      if (session.id !== sessionId) return session;
      return {
        ...session,
        analysis: session.analysis ? {
          ...session.analysis,
          exercises: session.analysis.exercises.map(ex => {
            if (ex.id !== exerciseId) return ex;
            return { ...ex, name: newName };
          })
        } : session.analysis
      };
    });
    setSessions(updated);
    const changed = updated.find(s => s.id === sessionId);
    if (trainerId && changed) {
      updateSession(trainerId, sessionId, { analysis: changed.analysis }).catch(console.error);
    }
  };

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const groupedSessions = sessions.reduce((acc, session) => {
    const name = session.clientName || 'Unnamed Athlete';
    if (!acc[name]) acc[name] = [];
    acc[name].push(session);
    return acc;
  }, {} as Record<string, TrainingSession[]>);

  const selectedSession = sessions.find(s => s.id === currentSessionId);

  // Mini Chart Component for Detailed View
  const EmphasisChart = ({ percentages }: { percentages: any }) => {
    const data = [
      { label: 'Upper', value: percentages.upperBody, color: '#00e5ff' },
      { label: 'Lower', value: percentages.lowerBody, color: '#007aff' },
      { label: 'Core', value: percentages.core, color: '#0052ff' },
      { label: 'Full', value: percentages.fullBody, color: '#94a3b8' }
    ];

    return (
      <div className="space-y-4">
        <h4 className="text-[10px] font-black text-slate-900 uppercase tracking-widest mb-4">Biomechanics Focus</h4>
        <div className="flex items-center gap-6">
          <div className="relative w-24 h-24">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#f1f5f9" strokeWidth="3" />
              {data.map((item, i) => {
                const total = data.slice(0, i).reduce((acc, d) => acc + d.value, 0);
                return (
                  <circle
                    key={i}
                    cx="18"
                    cy="18"
                    r="15.915"
                    fill="transparent"
                    stroke={item.color}
                    strokeWidth="4"
                    strokeDasharray={`${item.value} ${100 - item.value}`}
                    strokeDashoffset={-total}
                    className="transition-all duration-1000"
                  />
                );
              })}
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
               <span className="text-[8px] font-black uppercase text-slate-400">Target</span>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 flex-grow">
            {data.map((item, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }}></div>
                  <span className="text-[9px] font-black text-slate-500 uppercase">{item.label}</span>
                </div>
                <span className="text-[10px] font-black text-slate-900">{item.value}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Layout activeTab={view} onNavigate={setView} isRecording={isRecording}>
      {/* Migration dialog for first-time cloud login with existing local data */}
      {showMigration && trainerId && (
        <MigrationDialog
          trainerId={trainerId}
          onComplete={() => setShowMigration(false)}
          onSkip={() => setShowMigration(false)}
        />
      )}

      {view === 'recorder' && (
        <div className="space-y-6">
          <button 
            onClick={() => setView('dashboard')}
            className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-900 flex items-center gap-2 mb-4"
          >
            ← Back to Dashboard
          </button>
          <Recorder onSessionComplete={handleSessionComplete} onRecordingStateChange={setIsRecording} />
        </div>
      )}

      {view === 'library' && (
        <ExerciseLibrary 
          sessions={sessions} 
          onViewExercise={handleViewExerciseFromLibrary} 
          onUpdateGlobalTag={handleUpdateGlobalTag}
          onDeleteGlobalTag={handleDeleteGlobalTag}
          onAddTagToExercise={handleAddTagToExercise}
          onRemoveTagFromExercise={handleRemoveTagFromExercise}
          onUpdateExerciseName={handleUpdateExerciseName}
        />
      )}

      {view === 'dashboard' && (
        <div className="space-y-12">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">Training Ledger</h2>
              <div className="flex items-center gap-4 mt-2">
                {storageInfo && (
                  <div className="flex flex-col gap-1 min-w-[200px]">
                    <div className="flex justify-between items-center text-[9px] font-black uppercase tracking-widest text-slate-400">
                      <span>System Status</span>
                      <span>{storageInfo.used}MB / {Math.round(storageInfo.total / 1024)}GB</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                      <div 
                        className={`h-full transition-all duration-1000 ${storageInfo.percent > 90 ? 'bg-red-500' : storageInfo.percent > 70 ? 'bg-amber-400' : 'bg-brand-500'}`} 
                        style={{ width: `${storageInfo.percent}%` }}
                      ></div>
                    </div>
                  </div>
                )}
                <div className="h-8 w-px bg-slate-200 mx-2 hidden md:block"></div>
                <div className="flex items-center gap-2 text-green-600 px-3 py-1.5 bg-green-50 rounded-lg border border-green-100">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/>
                  </svg>
                  <span className="text-[9px] font-black uppercase tracking-widest">Cloud Synced</span>
                </div>
              </div>
            </div>
            
            <div className="flex flex-wrap items-center gap-4">
              <button 
                onClick={rescueOrphanedSessions}
                className="px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:border-brand-500 hover:text-brand-500 transition-all"
                title="Find videos that aren't appearing in your list"
              >
                Rescue Missing
              </button>
              {sessions.length > 0 && (
                <button 
                  onClick={() => {
                    setIsManageMode(!isManageMode);
                    if (isManageMode) setSelectedSessionIds(new Set());
                  }}
                  className={`px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center gap-2 ${isManageMode ? 'bg-slate-900 text-white shadow-xl' : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  {isManageMode ? 'Exit Management' : 'Manage Sessions'}
                </button>
              )}
              <button 
                onClick={() => setView('recorder')}
                className="bg-brand-500 text-white px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] shadow-lg shadow-brand-100 hover:bg-brand-600 transition-all flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 4v16m8-8H4" />
                </svg>
                New Record
              </button>
            </div>
          </div>

          {isAnalyzing && (
            <div className="bg-white border-2 border-brand-200 p-12 rounded-3xl text-center space-y-4 shadow-xl shadow-brand-50/50 animate-pulse">
               <div className="w-12 h-12 bg-brand-100 rounded-full mx-auto flex items-center justify-center animate-bounce">
                  <svg className="w-6 h-6 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
               </div>
               <div>
                 <div className="text-brand-500 font-black uppercase tracking-widest text-xs mb-1">Gemini AI Analysis</div>
                 <div className="text-slate-400 text-[10px] font-bold uppercase tracking-tight">Analyzing session — auto-clears in 70s</div>
               </div>
            </div>
          )}


          {sessions.length === 0 && !isAnalyzing ? (
            <div className="bg-white border-2 border-dashed border-slate-200 p-20 rounded-[40px] text-center">
               <p className="text-slate-400 font-black uppercase tracking-[0.2em] text-xs">No Training Data Found</p>
               <button 
                 onClick={() => setView('recorder')}
                 className="mt-6 text-brand-500 font-black text-[10px] uppercase tracking-widest hover:underline"
               >
                 Start your first session →
               </button>
            </div>
          ) : (
            <div className="space-y-16 pb-24">
              {isManageMode && (
                <div className="flex items-center gap-4 animate-in slide-in-from-top-2">
                  <button onClick={selectAllSessions} className="text-[10px] font-black text-brand-500 uppercase tracking-widest hover:underline">Select All</button>
                  <button onClick={deselectAllSessions} className="text-[10px] font-black text-slate-400 uppercase tracking-widest hover:underline">Deselect All</button>
                </div>
              )}
              
              {Object.keys(groupedSessions).sort().map(clientName => (
                <div key={clientName} className="space-y-6">
                  <div className="flex items-center gap-4 border-b border-slate-200 pb-2">
                    <h3 className="text-lg font-black text-slate-900 uppercase tracking-tight italic">{clientName}</h3>
                    <span className="bg-slate-100 text-slate-500 text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest">
                      {groupedSessions[clientName].length} Sessions
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {groupedSessions[clientName].map(session => (
                      <div 
                        key={session.id} 
                        onClick={() => isManageMode && toggleSessionSelection(session.id)}
                        className={`group bg-white border rounded-[32px] overflow-hidden transition-all duration-500 relative ${isManageMode ? 'cursor-pointer hover:scale-[1.02]' : ''} ${selectedSessionIds.has(session.id) ? 'border-brand-500 ring-4 ring-brand-50 shadow-2xl' : 'border-slate-200 hover:border-brand-200 hover:shadow-2xl'}`}
                      >
                        {isManageMode && (
                          <div className="absolute top-4 right-4 z-20">
                            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${selectedSessionIds.has(session.id) ? 'bg-brand-500 border-brand-500' : 'bg-white border-slate-300 shadow-sm'}`}>
                              {selectedSessionIds.has(session.id) && (
                                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                          </div>
                        )}
                        
                        <div className="aspect-video bg-slate-100 relative overflow-hidden">
                          {session.videoUrl ? (
                            <video src={session.videoUrl} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <svg className="w-10 h-10 text-slate-200" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M2 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                              </svg>
                            </div>
                          )}
                          <div className="absolute top-4 left-4 flex gap-2">
                             <span className="text-[8px] font-black px-2.5 py-1 rounded-lg uppercase tracking-widest bg-brand-500 text-white shadow-sm">
                               {formatDuration(session.duration || 0)}
                             </span>
                          </div>

                          {/* Cloud upload progress indicator */}
                          {uploadProgress[session.id] !== undefined && uploadProgress[session.id] !== 'synced' && uploadProgress[session.id] !== 'failed' && (
                            <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <div className="flex-grow h-1.5 bg-white/20 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-brand-500 rounded-full transition-all duration-300"
                                    style={{ width: `${uploadProgress[session.id]}%` }}
                                  />
                                </div>
                                <span className="text-[8px] font-black text-white shrink-0">{uploadProgress[session.id]}%</span>
                              </div>
                              <span className="text-[7px] text-white/60 uppercase tracking-widest">Uploading to Cloud</span>
                            </div>
                          )}

                          {session.status === 'processing' && (
                             <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
                                <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mb-3"></div>
                                <span className="text-[9px] font-black text-white uppercase tracking-widest">AI Audit in Progress</span>
                             </div>
                          )}

                          {session.status === 'failed' && (
                             <div className="absolute inset-0 bg-red-900/60 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
                                <svg className="w-8 h-8 text-white mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                                <span className="text-[9px] font-black text-white uppercase tracking-widest">Analysis Failed</span>
                                <button 
                                  onClick={(e) => { e.stopPropagation(); handleRetryAnalysis(session); }}
                                  className="mt-2 bg-white text-red-900 px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest hover:bg-red-50"
                                >
                                  Retry Analysis
                                </button>
                             </div>
                          )}
                        </div>
                        
                        <div className="p-6 space-y-4">
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="text-[10px] text-slate-400 font-black uppercase tracking-tighter">
                                {new Date(session.date).toLocaleDateString()}
                              </p>
                              <div className="text-[9px] font-black text-slate-300 uppercase tracking-widest bg-slate-50 px-2 py-1 rounded-md mt-1 w-fit">
                                {session.mode}
                              </div>
                            </div>
                            {session.syncStatus === 'synced' && (
                                <div className="bg-green-50 p-1.5 rounded-lg border border-green-100" title="Saved to Cloud">
                                  <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/>
                                  </svg>
                                </div>
                            )}
                          </div>

                          {session.status === 'failed' && session.error && (
                            <div className="bg-red-50 p-3 rounded-2xl border border-red-100">
                               <p className="text-[9px] text-red-600 font-bold leading-relaxed">{session.error}</p>
                            </div>
                          )}

                          {session.analysis && (
                             <div className="space-y-4">
                                <div className="bg-slate-50 p-3 rounded-2xl">
                                  <p className="text-[10px] text-slate-500 font-bold leading-relaxed line-clamp-2 italic">
                                    "{session.analysis.summary}"
                                  </p>
                                </div>
                                
                                <div className="space-y-2">
                                   {!isManageMode && (
                                     <button 
                                       onClick={(e) => {
                                         e.stopPropagation();
                                         setExpandedTranscripts(prev => ({ ...prev, [session.id]: !prev[session.id] }));
                                       }}
                                       className="text-[9px] font-black text-slate-400 uppercase tracking-widest hover:text-brand-500 transition-colors flex items-center gap-1"
                                     >
                                       <svg className={`w-3 h-3 transition-transform ${expandedTranscripts[session.id] ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                                       </svg>
                                       {expandedTranscripts[session.id] ? 'Hide Full Transcript' : 'Show Full Transcript'}
                                     </button>
                                   )}
                                   
                                   {expandedTranscripts[session.id] && (
                                     <div className="bg-slate-900 p-4 rounded-xl max-h-40 overflow-y-auto custom-scrollbar animate-in slide-in-from-top-2">
                                       <p className="text-[10px] font-mono text-slate-300 leading-relaxed whitespace-pre-wrap">
                                         {session.analysis.transcript || "No transcript data available for this session."}
                                       </p>
                                     </div>
                                   )}
                                </div>

                                <div className="flex flex-wrap gap-1.5">
                                   {session.tags.slice(0, 3).map(tag => (
                                     <span key={tag} className="text-[7px] bg-slate-100 text-slate-400 px-2 py-0.5 rounded-full uppercase font-black tracking-widest border border-slate-200">
                                       {tag}
                                     </span>
                                   ))}
                                </div>

                                {!isManageMode && (
                                  <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
                                     <div className="flex items-center gap-1">
                                       <div className="w-1.5 h-1.5 rounded-full bg-brand-500"></div>
                                       <span className="text-[9px] font-black text-slate-900 uppercase tracking-widest">
                                         {session.analysis.exercises.length} Exercises
                                       </span>
                                     </div>
                                     <button 
                                       onClick={(e) => { 
                                         e.stopPropagation();
                                         setCurrentSessionId(session.id); 
                                         setView('details'); 
                                         window.scrollTo({ top: 0, behavior: 'smooth' });
                                       }}
                                       className="text-brand-500 text-[10px] font-black uppercase tracking-widest hover:underline active:scale-95 transition-transform"
                                     >
                                       View Report →
                                     </button>
                                  </div>
                                )}
                             </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Bulk Action Bar */}
          {selectedSessionIds.size > 0 && (
            <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 bg-slate-900 text-white px-8 py-5 rounded-3xl shadow-2xl flex items-center gap-8 animate-in slide-in-from-bottom-8">
              <div className="flex flex-col">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Selection Active</span>
                <span className="text-sm font-black text-brand-400">{selectedSessionIds.size} Sessions Selected</span>
              </div>
              <div className="flex items-center gap-3">
                <button 
                  onClick={deselectAllSessions}
                  className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-300 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleBulkDelete}
                  className="bg-red-500 hover:bg-red-600 text-white px-6 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 shadow-lg shadow-red-900/40 transition-all active:scale-95"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete Selection
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {view === 'details' && selectedSession && (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setView('dashboard')}
              className="p-3 bg-white border border-slate-200 rounded-2xl shadow-sm hover:bg-slate-50 transition-colors"
            >
              <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <h2 className="text-3xl font-black text-slate-900 tracking-tight">{selectedSession.clientName}</h2>
              <div className="flex items-center gap-3">
                <p className="text-[10px] text-brand-500 font-black uppercase tracking-widest">{new Date(selectedSession.date).toLocaleString()}</p>
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest bg-slate-100 px-2 py-0.5 rounded-full">
                  Length: {formatDuration(selectedSession.duration || 0)}
                </span>
                {selectedSession.status === 'failed' && (
                  <span className="text-[9px] font-black text-red-500 uppercase tracking-widest bg-red-50 px-2 py-0.5 rounded-full border border-red-100">
                    Analysis Incomplete
                  </span>
                )}
              </div>
            </div>
            <button 
              onClick={() => handleDelete(selectedSession.id)}
              className="ml-auto text-red-500 p-3 hover:bg-red-50 rounded-2xl transition-all"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              <div className="aspect-video bg-black rounded-[32px] overflow-hidden shadow-2xl relative border-4 border-white">
                <video ref={videoPlayerRef} src={selectedSession.videoUrl} controls className="w-full h-full object-contain" />
              </div>

              {/* Phase 2 Progress Banner */}
              {(['specialists_running', 'consensus_running', 'report_generating'] as AnalysisJobStatus[]).includes(selectedSession.analysisStatus as AnalysisJobStatus) && (
                <div className="bg-gradient-to-r from-brand-50 to-violet-50 border border-brand-100 rounded-[32px] p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center">
                        <svg className="w-4 h-4 text-brand-600 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[10px] font-black text-brand-600 uppercase tracking-widest">Deep Analysis Running</p>
                        <p className="text-sm font-semibold text-slate-700">
                          {getStatusLabel(selectedSession.analysisStatus as AnalysisJobStatus)}
                        </p>
                      </div>
                    </div>
                    <span className="text-[10px] font-black text-brand-500 uppercase tracking-widest">
                      {getStatusProgress(selectedSession.analysisStatus as AnalysisJobStatus)}%
                    </span>
                  </div>
                  <div className="w-full bg-brand-100 rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-brand-500 to-violet-500 rounded-full transition-all duration-700"
                      style={{ width: `${getStatusProgress(selectedSession.analysisStatus as AnalysisJobStatus)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium">
                    PT Expert, S&C Coach, and Audio Analyst are reviewing the session. Your coaching report will be ready shortly.
                  </p>
                </div>
              )}

              {/* Audio-not-used notice — shown after draft_ready if transcript is empty */}
              {selectedSession.analysisStatus === 'draft_ready' && !selectedSession.analysis?.transcript && (
                <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-5 py-3">
                  <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                    Audio analysis skipped — background noise or music detected. Visual analysis only.
                  </p>
                </div>
              )}

              {selectedSession.status === 'failed' ? (
                <div className="bg-white rounded-[32px] p-12 border border-slate-200 shadow-sm text-center space-y-4">
                   <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto text-slate-400">
                     <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                     </svg>
                   </div>
                   <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">AI Report Unavailable</h3>
                   <p className="text-sm text-slate-500 font-medium max-w-md mx-auto">
                     Something went wrong during the analysis process. You can still watch the video, but coaching cues and rep counts are missing.
                   </p>
                   <button
                     onClick={() => handleRetryAnalysis(selectedSession)}
                     className="bg-brand-500 text-white px-8 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-brand-100 hover:bg-brand-600 transition-all"
                   >
                     Retry AI Analysis
                   </button>
                </div>
              ) : (
                <>
                  <div className="bg-white rounded-[32px] p-8 border border-slate-200 shadow-sm space-y-6">
                    <div className="flex justify-between items-center">
                      <h3 className="text-xl font-black text-slate-900 italic tracking-tight uppercase">Technical Breakdown</h3>
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">{selectedSession.analysis?.exercises.length} Sets Analyzed</span>
                    </div>
                    
                    <div className="grid gap-6">
                      {selectedSession.analysis?.exercises.map((ex, i) => (
                        <div key={i} className="bg-slate-50 p-6 rounded-3xl border border-slate-100 flex flex-col md:flex-row justify-between gap-4 group/item hover:border-brand-200 transition-colors">
                          <div className="space-y-3 flex-grow">
                            <div className="flex items-center gap-3 group/exname">
                              <span className="text-[10px] font-black bg-slate-200 text-slate-600 px-2 py-0.5 rounded uppercase">{i+1}</span>
                              
                              {editingExerciseId === ex.id ? (
                                <input 
                                  autoFocus
                                  className="font-black text-slate-900 uppercase tracking-tight bg-white border-none rounded px-2 outline-none focus:ring-2 focus:ring-brand-500"
                                  value={tempExerciseName}
                                  onChange={(e) => setTempExerciseName(e.target.value)}
                                  onBlur={() => {
                                    if (tempExerciseName.trim()) handleUpdateExerciseName(selectedSession.id, ex.id, tempExerciseName.trim());
                                    setEditingExerciseId(null);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      if (tempExerciseName.trim()) handleUpdateExerciseName(selectedSession.id, ex.id, tempExerciseName.trim());
                                      setEditingExerciseId(null);
                                    }
                                  }}
                                />
                              ) : (
                                <>
                                  <h4 
                                    className="font-black text-slate-900 uppercase tracking-tight cursor-pointer hover:text-brand-500"
                                    onClick={() => {
                                      setEditingExerciseId(ex.id);
                                      setTempExerciseName(ex.name);
                                    }}
                                  >
                                    {ex.name}
                                  </h4>
                                  <button 
                                    onClick={() => {
                                      setEditingExerciseId(ex.id);
                                      setTempExerciseName(ex.name);
                                    }}
                                    className="opacity-0 group-hover/exname:opacity-100 text-slate-300 hover:text-brand-500 transition-all"
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                    </svg>
                                  </button>
                                </>
                              )}
                              
                              <button 
                                onClick={() => playExerciseClip(ex)}
                                className="bg-brand-500 text-white p-1.5 rounded-full shadow-lg shadow-brand-100 opacity-0 group-hover/item:opacity-100 transition-opacity active:scale-90"
                                title="Play Exercise Clip"
                              >
                                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                                </svg>
                              </button>
                            </div>
                            <ul className="space-y-1.5">
                              {ex.cues.map((cue, ci) => (
                                <li key={ci} className="text-xs text-slate-500 font-medium flex gap-2">
                                  <span className="text-brand-500">•</span> {cue}
                                </li>
                              ))}
                            </ul>
                            <div className="flex flex-wrap gap-1.5 pt-2">
                               {ex.tags.map(tag => (
                                 <span key={tag} className="text-[7px] bg-slate-200/50 text-slate-500 px-2 py-0.5 rounded-full uppercase font-black tracking-widest border border-slate-200">
                                   {tag}
                                 </span>
                               ))}
                            </div>
                            <div className="text-[8px] font-black text-slate-300 uppercase tracking-widest pt-1">
                              Timeline: {formatDuration(ex.startTime)} — {formatDuration(ex.endTime)}
                            </div>
                          </div>
                          <div className="text-right flex md:flex-col items-center md:items-end justify-between md:justify-start">
                            <div className="flex flex-col items-center md:items-end">
                              <span className="text-brand-500 text-2xl font-black tabular-nums">{ex.reps}</span>
                              <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Reps</span>
                            </div>
                            <button 
                              onClick={() => playExerciseClip(ex)}
                              className="md:mt-4 text-[9px] font-black text-brand-500 uppercase tracking-widest border border-brand-200 px-3 py-1.5 rounded-xl hover:bg-brand-50 transition-colors"
                            >
                              Play Set
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white rounded-[32px] p-8 border border-slate-200 shadow-sm space-y-6">
                    <div className="flex justify-between items-center">
                       <h3 className="text-xl font-black text-slate-900 italic tracking-tight uppercase">Session Transcript</h3>
                       <div className="bg-slate-100 px-3 py-1 rounded-full flex items-center gap-2">
                          <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
                          <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">AI Generated Audit</span>
                       </div>
                    </div>
                    
                    <div className="bg-slate-50 border border-slate-100 rounded-[24px] p-6 space-y-4">
                      <div className="space-y-2">
                        <span className="text-[9px] font-black text-brand-500 uppercase tracking-widest">Transcript Summary</span>
                        <p className="text-xs font-semibold text-slate-600 leading-relaxed italic border-l-4 border-brand-200 pl-4 py-1">
                          {selectedSession.analysis?.summary}
                        </p>
                      </div>
                      
                      <div className="pt-4 space-y-2">
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Full Session Log</span>
                        <div className="bg-slate-900 rounded-2xl p-6 h-60 overflow-y-auto custom-scrollbar">
                           <p className="text-[10px] font-mono text-slate-300 leading-loose whitespace-pre-wrap">
                            {selectedSession.analysis?.transcript || "No detailed conversation log captured for this clip."}
                           </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="space-y-8">
              {/* Biomechanics Chart */}
              {selectedSession.analysis?.emphasisPercentages && (
                <div className="bg-white rounded-[32px] p-8 border border-slate-200 shadow-sm">
                  <EmphasisChart percentages={selectedSession.analysis.emphasisPercentages} />
                </div>
              )}

              {selectedSession.analysis && (
                <>
                  <div className="bg-slate-900 text-white rounded-[32px] p-8 shadow-xl border border-slate-800">
                    <h3 className="text-[10px] font-black text-brand-400 uppercase tracking-[0.3em] mb-4">Trainer Summary</h3>
                    <p className="text-sm font-medium leading-relaxed italic text-slate-300">"{selectedSession.analysis.summary}"</p>
                  </div>

                  <div className="bg-white rounded-[32px] p-8 border border-slate-200 shadow-sm">
                    <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest mb-6 border-b border-slate-50 pb-4">Coaching Directives</h3>
                    <div className="space-y-6">
                      {selectedSession.analysis.trainerCues.map((cue, i) => (
                        <div key={i} className="flex gap-4 items-start">
                          <div className="w-6 h-6 bg-brand-50 rounded-lg flex items-center justify-center text-brand-500 text-[10px] font-black flex-shrink-0">{i+1}</div>
                          <p className="text-xs text-slate-600 font-semibold leading-relaxed">{cue}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 p-4 bg-slate-900 text-white text-[10px] rounded-2xl font-black uppercase tracking-widest shadow-2xl flex items-center gap-4">
          <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 20 20">
             <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-4 text-brand-400 uppercase">Dismiss</button>
        </div>
      )}
    </Layout>
  );
};

export default App;
