
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { TrainingSession, Exercise, LibraryExercise } from '../types';
import { subscribeLibrary, addExerciseToLibrary, captureVideoFrame } from '../services/exerciseLibraryService';
import { getSignedDownloadUrl } from '../services/gcsService';

type LibraryTab = 'my-exercises' | 'shared-library';

interface ExerciseLibraryProps {
  sessions: TrainingSession[];
  onViewExercise: (sessionId: string, exercise: Exercise) => void;
  onUpdateGlobalTag: (oldTag: string, newTag: string) => void;
  onDeleteGlobalTag: (tag: string) => void;
  onAddTagToExercise: (sessionId: string, exerciseId: string, tag: string) => void;
  onRemoveTagFromExercise: (sessionId: string, exerciseId: string, tag: string) => void;
  onUpdateExerciseName: (sessionId: string, exerciseId: string, newName: string) => void;
}

const ExerciseLibrary: React.FC<ExerciseLibraryProps> = ({
  sessions,
  onViewExercise,
  onUpdateGlobalTag,
  onDeleteGlobalTag,
  onAddTagToExercise,
  onRemoveTagFromExercise,
  onUpdateExerciseName,
}) => {
  const [tab, setTab] = useState<LibraryTab>('my-exercises');
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [isManagingTags, setIsManagingTags] = useState(false);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [exerciseTagInputs, setExerciseTagInputs] = useState<Record<string, string>>({});
  const [editingExerciseId, setEditingExerciseId] = useState<string | null>(null);
  const [newExerciseName, setNewExerciseName] = useState('');

  // Shared library state
  const [sharedLibrary, setSharedLibrary] = useState<LibraryExercise[]>([]);
  const [sharedLoading, setSharedLoading] = useState(true);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState<Record<string, boolean>>({});

  // Clip playback modal
  const [activeClip, setActiveClip] = useState<{ videoUrl: string; startTime: number; endTime: number; name: string } | null>(null);
  const [clipLoading, setClipLoading] = useState(false);
  const clipVideoRef = React.useRef<HTMLVideoElement>(null);
  const signedUrlCache = useRef<Record<string, string>>({});

  // Subscribe to shared library when tab is active
  useEffect(() => {
    if (tab !== 'shared-library') return;
    setSharedLoading(true);
    const unsubscribe = subscribeLibrary((exercises) => {
      setSharedLibrary(exercises);
      setSharedLoading(false);
    });
    return unsubscribe;
  }, [tab]);

  // --- My Exercises (local session data) ---
  const allExercises = useMemo(() => {
    return sessions.flatMap(session =>
      (session.analysis?.exercises || []).map(ex => ({
        ...ex,
        sessionId: session.id,
        clientName: session.clientName,
        date: session.date,
      }))
    );
  }, [sessions]);

  const uniqueTags = useMemo(() => {
    const tags = new Set<string>();
    allExercises.forEach(ex => ex.tags.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [allExercises]);

  const filteredMyExercises = useMemo(() => {
    return allExercises.filter(ex => {
      const q = search.toLowerCase();
      const matchesSearch = !q || ex.name.toLowerCase().includes(q) || ex.clientName.toLowerCase().includes(q) || ex.tags.some(t => t.toLowerCase().includes(q));
      const matchesTag = !selectedTag || ex.tags.includes(selectedTag);
      return matchesSearch && matchesTag;
    });
  }, [allExercises, search, selectedTag]);

  // --- Shared Library filtering (client-side on top of Firestore subscription) ---
  const filteredShared = useMemo(() => {
    return sharedLibrary.filter(ex => {
      const q = search.toLowerCase();
      const matchesSearch = !q || ex.name.toLowerCase().includes(q) || ex.clientName.toLowerCase().includes(q) || ex.sourceTrainerName.toLowerCase().includes(q) || ex.tags.some(t => t.toLowerCase().includes(q));
      const matchesTag = !selectedTag || ex.tags.includes(selectedTag);
      return matchesSearch && matchesTag;
    });
  }, [sharedLibrary, search, selectedTag]);

  const sharedTags = useMemo(() => {
    const tags = new Set<string>();
    sharedLibrary.forEach(ex => ex.tags.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [sharedLibrary]);

  // --- Tag management ---
  const handleStartEditTag = (tag: string) => { setEditingTag(tag); setNewTagName(tag); };
  const handleSaveEditTag = () => {
    if (editingTag && newTagName && editingTag !== newTagName) onUpdateGlobalTag(editingTag, newTagName);
    setEditingTag(null);
  };
  const handleAddTag = (sessionId: string, exerciseId: string) => {
    const tag = exerciseTagInputs[exerciseId]?.trim();
    if (tag) {
      onAddTagToExercise(sessionId, exerciseId, tag);
      setExerciseTagInputs(prev => ({ ...prev, [exerciseId]: '' }));
    }
  };

  // --- Exercise name editing ---
  const handleStartEditExerciseName = (ex: any) => { setEditingExerciseId(ex.id); setNewExerciseName(ex.name); };
  const handleSaveExerciseName = (sessionId: string, exerciseId: string) => {
    if (newExerciseName.trim()) onUpdateExerciseName(sessionId, exerciseId, newExerciseName.trim());
    setEditingExerciseId(null);
  };

  // --- Share to global library ---
  const handleShareToLibrary = useCallback(async (sessionId: string, exerciseId: string) => {
    setSharingId(exerciseId);
    try {
      // Try to capture thumbnail from session video
      let thumbnail: string | undefined;
      const session = sessions.find(s => s.id === sessionId);
      const exercise = session?.analysis?.exercises?.find(e => e.id === exerciseId);
      if (session?.videoUrl && exercise) {
        try {
          thumbnail = await captureVideoFrame(session.videoUrl, exercise.startTime + 1);
        } catch (e) {
          console.warn('Thumbnail capture failed, sharing without thumbnail:', e);
        }
      }

      const result = await addExerciseToLibrary(sessionId, exerciseId, thumbnail);
      setShareSuccess(prev => ({ ...prev, [exerciseId]: true }));
      if (result.alreadyExists) {
        alert('This exercise is already in the shared library!');
      }
    } catch (err: any) {
      console.error('Failed to share exercise:', err);
      alert(`Could not share exercise: ${err.message || 'Unknown error'}`);
    } finally {
      setSharingId(null);
    }
  }, [sessions]);

  // --- Clip playback (resolves GCS paths to signed URLs) ---
  const resolveVideoUrl = useCallback(async (urlOrPath: string): Promise<string> => {
    // Already a playable URL
    if (urlOrPath.startsWith('http') || urlOrPath.startsWith('blob:')) return urlOrPath;
    // Check cache
    if (signedUrlCache.current[urlOrPath]) return signedUrlCache.current[urlOrPath];
    // Resolve GCS path to signed URL
    const signedUrl = await getSignedDownloadUrl(urlOrPath);
    signedUrlCache.current[urlOrPath] = signedUrl;
    return signedUrl;
  }, []);

  const handlePlayClip = useCallback(async (videoUrlOrPath: string, startTime: number, endTime: number, name: string) => {
    setClipLoading(true);
    try {
      const videoUrl = await resolveVideoUrl(videoUrlOrPath);
      setActiveClip({ videoUrl, startTime, endTime, name });
    } catch (err) {
      console.error('Failed to get signed URL for clip:', err);
      alert('Could not load video. The video may not be available.');
    } finally {
      setClipLoading(false);
    }
  }, [resolveVideoUrl]);

  // Pause clip at endTime
  useEffect(() => {
    if (!activeClip || !clipVideoRef.current) return;
    const video = clipVideoRef.current;
    const handleTime = () => {
      if (video.currentTime >= activeClip.endTime) {
        video.pause();
      }
    };
    video.addEventListener('timeupdate', handleTime);
    return () => video.removeEventListener('timeupdate', handleTime);
  }, [activeClip]);

  // Seek to start when clip opens
  useEffect(() => {
    if (!activeClip || !clipVideoRef.current) return;
    const video = clipVideoRef.current;
    const handleLoaded = () => {
      video.currentTime = activeClip.startTime;
      video.play().catch(() => {});
    };
    video.addEventListener('loadedmetadata', handleLoaded);
    if (video.readyState >= 1) handleLoaded();
    return () => video.removeEventListener('loadedmetadata', handleLoaded);
  }, [activeClip]);

  const activeTags = tab === 'shared-library' ? sharedTags : uniqueTags;

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-2">
          <h2 className="text-3xl font-black text-slate-900 tracking-tight">Exercise Library</h2>
          <p className="text-slate-500 text-xs font-bold uppercase tracking-widest">
            {tab === 'my-exercises'
              ? `${allExercises.length} recorded sets from your sessions`
              : `${sharedLibrary.length} exercises shared across all trainers`}
          </p>
        </div>
        {tab === 'my-exercises' && (
          <button
            onClick={() => setIsManagingTags(!isManagingTags)}
            className={`px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${isManagingTags ? 'bg-slate-900 text-white shadow-xl' : 'bg-white text-slate-600 border border-slate-200 hover:border-brand-500 hover:text-brand-500'}`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            {isManagingTags ? 'Exit Tag Manager' : 'Manage Global Tags'}
          </button>
        )}
      </div>

      {/* Tab Switcher */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-2xl w-fit">
        <button
          onClick={() => setTab('my-exercises')}
          className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tab === 'my-exercises' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
        >
          My Sessions
        </button>
        <button
          onClick={() => setTab('shared-library')}
          className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${tab === 'shared-library' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/>
          </svg>
          Shared Library
          {sharedLibrary.length > 0 && (
            <span className="bg-brand-500 text-white text-[7px] font-black px-1.5 py-0.5 rounded-full">{sharedLibrary.length}</span>
          )}
        </button>
      </div>

      {/* Global Tag Manager (My Sessions only) */}
      {tab === 'my-exercises' && isManagingTags && (
        <div className="bg-slate-900 p-8 rounded-[40px] shadow-2xl space-y-6 animate-in slide-in-from-top-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <h3 className="text-xs font-black text-brand-400 uppercase tracking-[0.3em]">Global Tag Taxonomy</h3>
            <span className="text-[10px] text-slate-500 font-bold uppercase">{uniqueTags.length} Unique Tags Found</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {uniqueTags.map(tag => (
              <div key={tag} className="flex items-center justify-between bg-slate-800 p-4 rounded-2xl group">
                {editingTag === tag ? (
                  <div className="flex items-center gap-2 w-full">
                    <input autoFocus className="bg-slate-700 text-white text-xs px-3 py-1.5 rounded-lg border-none focus:ring-2 focus:ring-brand-500 flex-grow"
                      value={newTagName} onChange={e => setNewTagName(e.target.value)}
                      onBlur={handleSaveEditTag} onKeyDown={e => e.key === 'Enter' && handleSaveEditTag()} />
                  </div>
                ) : (
                  <>
                    <span className="text-xs text-white font-black uppercase tracking-widest truncate max-w-[150px]">{tag}</span>
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => handleStartEditTag(tag)} className="p-2 text-slate-400 hover:text-brand-400 hover:bg-slate-700 rounded-lg">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button onClick={() => window.confirm(`Remove "${tag}" from ALL exercises?`) && onDeleteGlobalTag(tag)}
                        className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
            {uniqueTags.length === 0 && (
              <p className="text-slate-600 text-[10px] font-black uppercase tracking-widest col-span-full py-4 text-center">No tags yet.</p>
            )}
          </div>
        </div>
      )}

      {/* Search + Filters */}
      <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm space-y-8">
        <div className="flex-1 relative">
          <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input type="text"
            placeholder={tab === 'shared-library' ? 'Search shared library by name, tag, or trainer...' : 'Search by exercise name, tag, or athlete...'}
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-12 pr-6 py-4 bg-slate-50 border-none rounded-2xl outline-none focus:ring-4 focus:ring-brand-100 transition-all font-semibold text-sm"
          />
        </div>
        <div className="space-y-3">
          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Quick Filters</div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSelectedTag(null)}
              className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!selectedTag ? 'bg-brand-500 text-white shadow-lg shadow-brand-100' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}>
              All
            </button>
            {activeTags.map(tag => (
              <button key={tag} onClick={() => setSelectedTag(tag === selectedTag ? null : tag)}
                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${selectedTag === tag ? 'bg-brand-500 text-white shadow-lg shadow-brand-100' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}>
                {tag}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Exercise Grid */}
      {tab === 'my-exercises' ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {filteredMyExercises.map(ex => (
              <div key={`${ex.sessionId}-${ex.id}`} className="group bg-white border border-slate-200 rounded-[32px] overflow-hidden hover:border-brand-200 hover:shadow-2xl transition-all duration-500 flex flex-col">
                <div className="p-6 flex-grow space-y-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-grow pr-4">
                      {editingExerciseId === ex.id ? (
                        <input autoFocus
                          className="w-full font-black text-slate-900 uppercase tracking-tight text-lg bg-slate-50 border-none rounded-lg focus:ring-2 focus:ring-brand-500 outline-none px-2"
                          value={newExerciseName} onChange={e => setNewExerciseName(e.target.value)}
                          onBlur={() => handleSaveExerciseName(ex.sessionId, ex.id)}
                          onKeyDown={e => e.key === 'Enter' && handleSaveExerciseName(ex.sessionId, ex.id)} />
                      ) : (
                        <div className="flex items-center gap-2 group/title">
                          <h4 className="font-black text-slate-900 uppercase tracking-tight text-lg group-hover:text-brand-500 transition-colors cursor-pointer"
                            onClick={() => handleStartEditExerciseName(ex)}>{ex.name}</h4>
                          <button onClick={() => handleStartEditExerciseName(ex)}
                            className="opacity-0 group-hover/title:opacity-100 text-slate-300 hover:text-brand-500 transition-all">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                          </button>
                        </div>
                      )}
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">
                        Athlete: <span className="text-slate-900 italic">{ex.clientName}</span>
                      </p>
                    </div>
                    <div className="bg-brand-50 text-brand-500 text-[10px] font-black px-2 py-1 rounded-lg uppercase whitespace-nowrap">{ex.reps} Reps</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ex.tags.map(tag => (
                      <span key={tag} className="group/tag text-[7px] bg-slate-50 text-slate-400 px-2 py-0.5 rounded-full uppercase font-black tracking-widest border border-slate-100 flex items-center gap-1.5 hover:bg-brand-50 hover:text-brand-500 transition-colors">
                        {tag}
                        <button onClick={() => onRemoveTagFromExercise(ex.sessionId, ex.id, tag)}
                          className="opacity-0 group-hover/tag:opacity-100 hover:text-red-500 transition-opacity">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="bg-slate-50 p-4 rounded-2xl">
                    <p className="text-[10px] font-bold text-slate-500 italic leading-relaxed">"{ex.cues[0] || 'High intensity performance'}"</p>
                  </div>
                  <div className="pt-2 flex items-center gap-2">
                    <input type="text" placeholder="Add custom tag..."
                      value={exerciseTagInputs[ex.id] || ''}
                      onChange={e => setExerciseTagInputs(prev => ({ ...prev, [ex.id]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && handleAddTag(ex.sessionId, ex.id)}
                      className="bg-slate-50 border-none text-[9px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-lg flex-grow placeholder:text-slate-300 outline-none focus:ring-1 focus:ring-brand-200" />
                    <button onClick={() => handleAddTag(ex.sessionId, ex.id)}
                      className="text-[10px] font-black text-brand-500 hover:text-brand-600 uppercase tracking-widest">Add</button>
                  </div>
                </div>
                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-2">
                  <button onClick={() => onViewExercise(ex.sessionId, ex)}
                    className="text-[10px] font-black text-brand-500 uppercase tracking-widest hover:underline flex items-center gap-2">
                    View in Session
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </button>
                  {(() => {
                    const session = sessions.find(s => s.id === ex.sessionId);
                    return session?.videoUrl ? (
                      <button
                        onClick={() => handlePlayClip(session.videoUrl!, ex.startTime, ex.endTime, ex.name)}
                        className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:text-brand-500 hover:bg-brand-50 transition-all"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                        </svg>
                        Play Clip
                      </button>
                    ) : null;
                  })()}
                  <button
                    onClick={() => handleShareToLibrary(ex.sessionId, ex.id)}
                    disabled={sharingId === ex.id || shareSuccess[ex.id]}
                    className={`text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${shareSuccess[ex.id] ? 'text-green-600 bg-green-50' : 'text-slate-400 hover:text-brand-500 hover:bg-brand-50'}`}
                    title="Share to global exercise library"
                  >
                    {sharingId === ex.id ? (
                      <span className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                    ) : shareSuccess[ex.id] ? (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/>
                      </svg>
                    )}
                    {shareSuccess[ex.id] ? 'Shared!' : 'Share'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {filteredMyExercises.length === 0 && (
            <div className="py-20 text-center bg-white border-2 border-dashed border-slate-200 rounded-[40px]">
              <p className="text-slate-400 font-black uppercase tracking-widest text-xs">No matching exercises in your sessions</p>
            </div>
          )}
        </>
      ) : (
        <>
          {sharedLoading ? (
            <div className="py-20 text-center">
              <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-slate-400 font-black uppercase tracking-widest text-xs">Loading shared library...</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {filteredShared.map(ex => (
                  <div key={ex.id} className="group bg-white border border-slate-200 rounded-[32px] overflow-hidden hover:border-brand-200 hover:shadow-2xl transition-all duration-500 flex flex-col">
                    {/* Thumbnail */}
                    {ex.thumbnailBase64 ? (
                      <div className="relative aspect-video bg-slate-900 cursor-pointer" onClick={() => ex.videoPath && handlePlayClip(ex.videoPath, ex.startTime, ex.endTime, ex.name)}>
                        <img src={`data:image/jpeg;base64,${ex.thumbnailBase64}`} alt={ex.name} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center shadow-lg">
                            <svg className="w-5 h-5 text-brand-500 ml-0.5" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                            </svg>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="aspect-video bg-gradient-to-br from-slate-100 to-slate-200 flex flex-col items-center justify-center gap-2 cursor-pointer hover:from-slate-200 hover:to-slate-300 transition-colors"
                        onClick={() => ex.videoPath && handlePlayClip(ex.videoPath, ex.startTime, ex.endTime, ex.name)}
                      >
                        <svg className="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Tap to play</span>
                      </div>
                    )}
                    <div className="p-6 flex-grow space-y-4">
                      <div className="flex justify-between items-start">
                        <div className="flex-grow pr-4">
                          <h4 className="font-black text-slate-900 uppercase tracking-tight text-lg group-hover:text-brand-500 transition-colors">{ex.name}</h4>
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">
                            Athlete: <span className="text-slate-900 italic">{ex.clientName}</span>
                          </p>
                          <p className="text-[9px] font-black text-brand-400 uppercase tracking-widest">
                            By: {ex.sourceTrainerName}
                          </p>
                        </div>
                        <div className="bg-brand-50 text-brand-500 text-[10px] font-black px-2 py-1 rounded-lg uppercase whitespace-nowrap">{ex.reps} Reps</div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {ex.tags.map(tag => (
                          <span key={tag} className="text-[7px] bg-slate-50 text-slate-400 px-2 py-0.5 rounded-full uppercase font-black tracking-widest border border-slate-100">{tag}</span>
                        ))}
                      </div>
                      <div className="bg-slate-50 p-4 rounded-2xl">
                        <p className="text-[10px] font-bold text-slate-500 italic leading-relaxed">"{ex.cues[0] || 'High intensity performance'}"</p>
                      </div>
                      {ex.cues.length > 1 && (
                        <ul className="space-y-1">
                          {ex.cues.slice(1).map((cue, i) => (
                            <li key={i} className="text-xs text-slate-500 flex gap-2">
                              <span className="text-brand-500">•</span>{cue}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-[9px] font-black text-slate-300 uppercase">
                        {new Date(ex.sessionDate).toLocaleDateString()}
                      </span>
                      {ex.videoPath && (
                        <button
                          onClick={() => handlePlayClip(ex.videoPath, ex.startTime, ex.endTime, ex.name)}
                          className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:text-brand-500 hover:bg-brand-50 transition-all"
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                          </svg>
                          Play Clip
                        </button>
                      )}
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                        {Math.round((ex.endTime - ex.startTime))}s clip
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {filteredShared.length === 0 && !sharedLoading && (
                <div className="py-20 text-center bg-white border-2 border-dashed border-slate-200 rounded-[40px]">
                  <p className="text-slate-400 font-black uppercase tracking-widest text-xs">
                    {sharedLibrary.length === 0 ? 'No exercises shared yet — be the first!' : 'No exercises match your search'}
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}
      {/* Clip Loading Overlay */}
      {clipLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-white text-xs font-black uppercase tracking-widest">Loading clip...</p>
          </div>
        </div>
      )}
      {/* Clip Playback Modal */}
      {activeClip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setActiveClip(null)}>
          <div className="bg-white rounded-[32px] overflow-hidden shadow-2xl max-w-2xl w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <h4 className="font-black text-slate-900 uppercase tracking-tight text-sm">{activeClip.name}</h4>
              <button onClick={() => setActiveClip(null)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="aspect-video bg-black">
              <video
                ref={clipVideoRef}
                src={activeClip.videoUrl}
                controls
                className="w-full h-full object-contain"
              />
            </div>
            <div className="p-4 text-center">
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                Clip: {Math.round(activeClip.startTime)}s — {Math.round(activeClip.endTime)}s ({Math.round(activeClip.endTime - activeClip.startTime)}s)
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExerciseLibrary;
