
import React, { useRef, useState, useCallback, useEffect } from 'react';
import { SessionMode } from '../types';

type CameraKind = 'ultrawide' | 'wide' | 'telephoto' | 'front' | 'unknown';

interface CameraDevice {
  deviceId: string;
  label: string;
  kind: CameraKind;
  focalLengthRange?: { min: number; max: number };
}

interface RecorderProps {
  onSessionComplete: (blob: Blob, clientName: string, mode: SessionMode, snapshots: string[], duration: number) => void;
  onRecordingStateChange?: (isRecording: boolean) => void;
}

/** Race a promise against a timeout — rejects with a descriptive error on timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

const Recorder: React.FC<RecorderProps> = ({ onSessionComplete, onRecordingStateChange }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const isStartingRef = useRef(false);
  const startingTimestampRef = useRef(0); // Safety: track when startCamera began
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);

  const [recording, setRecording] = useState(false);
  const [clientName, setClientName] = useState('');
  const [chunks, setChunks] = useState<Blob[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [timer, setTimer] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SessionMode>('clip');
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [isSwitchingLens, setIsSwitchingLens] = useState(false);
  const [cameraStartingSlow, setCameraStartingSlow] = useState(false);

  // Camera lens selection state
  const [availableCameras, setAvailableCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const camerasEnumeratedRef = useRef(false);

  // Microphone selection state
  const [availableMics, setAvailableMics] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnimFrameRef = useRef<number>(0);

  // Keep streamRef in sync with state for cleanup
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      onRecordingStateChange?.(false);
    };
  }, [onRecordingStateChange]);

  // Audio level meter — monitors mic input when stream is active
  useEffect(() => {
    if (!stream) {
      setAudioLevel(0);
      return;
    }
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      setAudioLevel(0);
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    audioContextRef.current = ctx;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const updateLevel = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length;
      setAudioLevel(avg / 255); // normalize to 0–1
      audioAnimFrameRef.current = requestAnimationFrame(updateLevel);
    };
    updateLevel();

    return () => {
      cancelAnimationFrame(audioAnimFrameRef.current);
      source.disconnect();
      ctx.close().catch(() => {});
      audioContextRef.current = null;
    };
  }, [stream]);

  const captureSnapshot = useCallback(() => {
    if (!videoRef.current || !recording) return;

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(videoRef.current, 0, 0, 320, 180);
      const base64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
      setSnapshots(prev => {
        if (prev.length > 500) return prev;
        return [...prev, base64];
      });
    }
  }, [recording]);

  useEffect(() => {
    let interval: any;
    let snapshotInterval: any;

    if (recording) {
      interval = setInterval(() => setTimer(t => t + 1), 1000);
      const freq = mode === 'clip' ? 2000 : (mode === 'workout30' ? 5000 : 12000);
      snapshotInterval = setInterval(captureSnapshot, freq);
    }

    return () => {
      clearInterval(interval);
      clearInterval(snapshotInterval);
    };
  }, [recording, captureSnapshot, mode]);

  // Helper: stop tracks directly via ref (avoids stale closure issues)
  const stopTracksOnly = useCallback(() => {
    const currentStream = streamRef.current;
    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
    }
  }, []);

  // Attach stream to video element whenever stream changes
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.setAttribute('playsinline', 'true');
      videoRef.current.onloadedmetadata = async () => {
        try {
          await videoRef.current?.play();
        } catch (e) {
          console.error("Playback failed:", e);
        }
      };
    }
  }, [stream]);

  // Build audio constraint based on selected mic
  const getAudioConstraint = useCallback((): MediaTrackConstraints | boolean => {
    if (selectedMicId) return { deviceId: { exact: selectedMicId } };
    return true;
  }, [selectedMicId]);

  // Classify a camera device by its label
  const classifyByLabel = (label: string): CameraKind => {
    const l = label.toLowerCase();
    if (l.includes('front') || l.includes('facing front') || l.includes('facetime')) return 'front';
    if (l.includes('ultra') || l.includes('0.5x') || l.includes('0.5')) return 'ultrawide';
    if (l.includes('tele') || l.includes('2x') || l.includes('3x') || l.includes('5x') || l.includes('zoom')) return 'telephoto';
    if (l.includes('wide') && !l.includes('ultra')) return 'wide';
    return 'unknown';
  };

  // Enumerate and classify all available cameras
  const enumerateAndClassifyCameras = useCallback(async (): Promise<CameraDevice[]> => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    if (videoDevices.length <= 1) return []; // No point showing selector for a single camera

    const classified: CameraDevice[] = [];

    for (const device of videoDevices) {
      const camera: CameraDevice = {
        deviceId: device.deviceId,
        label: device.label || `Camera ${classified.length + 1}`,
        kind: 'unknown',
      };

      // Fast classification from label (no stream needed)
      camera.kind = classifyByLabel(camera.label);

      // If still unknown or needs verification, probe capabilities via temporary stream
      if ((camera.kind === 'unknown' || camera.kind === 'wide') && device.label) {
        try {
          const tempStream = await withTimeout(
            navigator.mediaDevices.getUserMedia({
              video: { deviceId: { ideal: device.deviceId } },
              audio: false,
            }),
            5000, 'Camera probe'
          );
          const track = tempStream.getVideoTracks()[0];
          if (track && typeof track.getCapabilities === 'function') {
            const caps = track.getCapabilities() as any;
            if (caps.focalLength) {
              camera.focalLengthRange = { min: caps.focalLength.min, max: caps.focalLength.max };
              if (caps.focalLength.min < 20) camera.kind = 'ultrawide';
              else if (caps.focalLength.min < 40) camera.kind = 'wide';
              else camera.kind = 'telephoto';
            }
            // Also check zoom range — cameras with zoom.min < 1 are typically ultra-wide
            if (!camera.focalLengthRange && caps.zoom) {
              if (caps.zoom.min < 1) camera.kind = 'ultrawide';
            }
          }
          tempStream.getTracks().forEach(t => t.stop());
          // Small delay to let hardware fully release before probing next camera
          await new Promise(r => setTimeout(r, 150));
        } catch (e) {
          console.warn(`Could not probe camera ${device.label}:`, e);
        }
      }

      // Default: non-front unknown cameras are probably "wide" (the main camera)
      if (camera.kind === 'unknown') {
        const l = camera.label.toLowerCase();
        if (!l.includes('front') && !l.includes('facetime')) {
          camera.kind = 'wide';
        } else {
          camera.kind = 'front';
        }
      }

      classified.push(camera);
    }

    // Sort: ultrawide first, then wide, telephoto, front, unknown
    const sortOrder: Record<CameraKind, number> = { ultrawide: 0, wide: 1, telephoto: 2, front: 3, unknown: 4 };
    classified.sort((a, b) => sortOrder[a.kind] - sortOrder[b.kind]);

    // Deduplicate: if multiple rear cameras share the same kind (e.g. all "wide"),
    // assign distinct kinds based on position — typically widest first on most phones
    const rearCams = classified.filter(c => c.kind !== 'front');
    const allSameKind = rearCams.length > 1 && rearCams.every(c => c.kind === rearCams[0].kind);
    if (allSameKind && rearCams.length >= 2) {
      // Assign by position: most phones enumerate ultra-wide, wide, telephoto in order
      // But some put main camera first — use focal length data if available
      const withFocal = rearCams.filter(c => c.focalLengthRange);
      if (withFocal.length >= 2) {
        withFocal.sort((a, b) => a.focalLengthRange!.min - b.focalLengthRange!.min);
        withFocal[0].kind = 'ultrawide';
        if (withFocal.length >= 3) withFocal[withFocal.length - 1].kind = 'telephoto';
        // Middle one(s) stay as 'wide'
      } else {
        // No focal length data — assign by position
        if (rearCams.length === 2) {
          rearCams[0].kind = 'ultrawide';
          rearCams[1].kind = 'wide';
        } else if (rearCams.length >= 3) {
          rearCams[0].kind = 'ultrawide';
          rearCams[1].kind = 'wide';
          rearCams[2].kind = 'telephoto';
        }
      }
      // Re-sort after reassignment
      classified.sort((a, b) => sortOrder[a.kind] - sortOrder[b.kind]);
    }

    return classified;
  }, []);

  const startCamera = async (facing: 'user' | 'environment', deviceId?: string) => {
    // Safety: if isStartingRef has been stuck for more than 10 seconds, force-reset it
    if (isStartingRef.current) {
      const elapsed = Date.now() - startingTimestampRef.current;
      if (elapsed > 10000) {
        console.warn(`isStartingRef was stuck for ${elapsed}ms, force-resetting`);
        isStartingRef.current = false;
        setIsSwitchingLens(false);
      } else {
        console.warn('startCamera called while already starting, ignoring');
        return;
      }
    }
    isStartingRef.current = true;
    startingTimestampRef.current = Date.now();
    setError(null);
    setCameraStartingSlow(false);

    // Show "Camera starting..." after 5 seconds if still not ready
    const slowTimer = setTimeout(() => setCameraStartingSlow(true), 5000);

    // If we already have a stream, this is a lens/camera switch — show switching indicator
    const isSwitch = !!streamRef.current;
    if (isSwitch) setIsSwitchingLens(true);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError("Your browser does not support camera access. Please use a modern browser like Chrome or Safari.");
        return;
      }

      // Stop old tracks directly via ref (avoids stale closure issues with useCallback)
      // DON'T set stream to null — keep the video element mounted during the switch
      const oldStream = streamRef.current;
      if (oldStream) {
        oldStream.getTracks().forEach(t => t.stop());
      }

      // Brief delay for phone hardware to release camera
      await new Promise(r => setTimeout(r, 250));

      // Build constraints — use "exact" for deviceId to ensure we get the RIGHT camera,
      // but with a proper fallback cascade that drops to facingMode if exact fails
      const exactDeviceConstraints: MediaTrackConstraints | null = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : null;

      const facingConstraints: MediaTrackConstraints = {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      };

      const audioConstraint = getAudioConstraint();
      let s: MediaStream | null = null;

      // When a specific device is requested, try exact first (so we get the right lens)
      if (exactDeviceConstraints) {
        try {
          s = await withTimeout(
            navigator.mediaDevices.getUserMedia({ video: exactDeviceConstraints, audio: audioConstraint }),
            8000, 'Camera access'
          );
        } catch (e1: any) {
          console.warn("Exact deviceId + audio failed, trying without audio...", e1);
          try {
            s = await withTimeout(
              navigator.mediaDevices.getUserMedia({ video: exactDeviceConstraints, audio: false }),
              8000, 'Camera access'
            );
          } catch (e2: any) {
            console.warn("Exact deviceId failed entirely, falling back to facingMode...", e2);
            s = null; // Will fall through to facingMode fallback below
          }
        }
      }

      // If no device requested OR exact deviceId failed, use facingMode
      if (!s) {
        try {
          s = await withTimeout(
            navigator.mediaDevices.getUserMedia({ video: facingConstraints, audio: audioConstraint }),
            8000, 'Camera access'
          );
        } catch (e3: any) {
          console.warn("FacingMode + audio failed, trying without audio...", e3);
          try {
            s = await withTimeout(
              navigator.mediaDevices.getUserMedia({ video: facingConstraints, audio: false }),
              8000, 'Camera access'
            );
            setError("Microphone access denied. Recording video only.");
          } catch (e4: any) {
            console.warn("FacingMode failed, trying absolute fallback...", e4);
            try {
              s = await withTimeout(
                navigator.mediaDevices.getUserMedia({ video: true }),
                8000, 'Camera access'
              );
            } catch (e5: any) {
              console.error("All camera attempts failed:", e5);
              throw e5;
            }
          }
        }
      }

      // Update stream ref immediately (before React re-render) to prevent stale refs
      streamRef.current = s;
      setStream(s);
      setFacingMode(facing);

      // Detect which camera we actually got and update the active lens indicator
      const activeTrack = s.getVideoTracks()[0];
      const actualSettings = activeTrack?.getSettings?.();
      if (actualSettings?.deviceId) {
        setSelectedCameraId(actualSettings.deviceId);
      } else if (deviceId) {
        setSelectedCameraId(deviceId);
      }

      // Enumerate audio devices after first successful stream
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
        setAvailableMics(mics);
        // Detect which mic we actually got
        const audioTrack = s.getAudioTracks()[0];
        if (audioTrack) {
          const audioSettings = audioTrack.getSettings();
          if (audioSettings.deviceId && !selectedMicId) {
            setSelectedMicId(audioSettings.deviceId);
          }
        }
      } catch (e) {
        console.warn('Audio device enumeration failed:', e);
      }

      // After first successful camera access, enumerate and classify all cameras
      if (!camerasEnumeratedRef.current) {
        camerasEnumeratedRef.current = true;
        try {
          const cameras = await enumerateAndClassifyCameras();
          setAvailableCameras(cameras);

          // Auto-switch to widest lens if we're on the rear camera and haven't selected one yet
          if (!deviceId && facing === 'environment' && cameras.length > 0) {
            const ultrawide = cameras.find(c => c.kind === 'ultrawide');
            if (ultrawide) {
              // Re-start with the ultra-wide camera (must reset flag first)
              isStartingRef.current = false;
              setIsSwitchingLens(false);
              clearTimeout(slowTimer);
              setCameraStartingSlow(false);
              await startCamera('environment', ultrawide.deviceId);
              return;
            }
          }
        } catch (e) {
          console.warn('Camera enumeration failed:', e);
        }
      }
    } catch (err: any) {
      console.error("Camera access error:", err?.name, err?.message);

      // Camera truly failed — now clear the stream
      streamRef.current = null;
      setStream(null);

      if (err.name === 'AbortError') {
        setError("Camera hardware failed to start. Please close other apps and refresh the page.");
      } else if (err.name === 'NotReadableError' || err.message?.includes('videosource')) {
        setError("Camera is currently locked by another app. Please close other apps and try again.");
      } else if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        setError("Camera permission denied. Please allow camera access in your browser settings.");
      } else if (err.message?.includes('timed out')) {
        setError("Camera took too long to start. Please close other apps and try again.");
      } else {
        const errorMsg = err.message || (typeof err === 'string' ? err : JSON.stringify(err)) || "Unknown error";
        setError("Could not start camera. " + errorMsg);
      }
    } finally {
      isStartingRef.current = false;
      setIsSwitchingLens(false);
      clearTimeout(slowTimer);
      setCameraStartingSlow(false);
    }
  };

  const toggleCamera = () => {
    if (facingMode === 'user') {
      // Switching back to rear: use previously selected rear camera or default
      if (selectedCameraId) {
        const selectedCam = availableCameras.find(c => c.deviceId === selectedCameraId);
        if (selectedCam && selectedCam.kind !== 'front') {
          startCamera('environment', selectedCameraId);
          return;
        }
      }
      startCamera('environment');
    } else {
      // Switching to front: find front camera device if available
      const frontCamera = availableCameras.find(c => c.kind === 'front');
      if (frontCamera) {
        startCamera('user', frontCamera.deviceId);
      } else {
        startCamera('user');
      }
    }
  };

  // Handle mic change from dropdown
  const handleMicChange = useCallback((micId: string) => {
    setSelectedMicId(micId);
    // Restart stream with new mic — need to re-acquire getUserMedia
    if (streamRef.current) {
      const currentFacing = facingMode;
      const currentCameraId = selectedCameraId;
      // Small delay to let React state update
      setTimeout(() => {
        startCamera(currentFacing, currentCameraId || undefined);
      }, 100);
    }
  }, [facingMode, selectedCameraId]);

  const startRecording = useCallback(() => {
    if (!stream) return;
    setChunks([]);
    setSnapshots([]);
    setTimer(0);

    // Fallback for Safari/Mobile support
    const mimeType = [
      'video/webm;codecs=vp8,opus',
      'video/mp4',
      'video/webm'
    ].find(t => MediaRecorder.isTypeSupported(t)) || '';

    const bitrate = mode === 'clip' ? 400000 : 250000;

    try {
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) setChunks(p => [...p, e.data]); };
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setRecording(true);
      onRecordingStateChange?.(true);
    } catch (e: any) {
      console.error("Recorder error:", e);
      const errorMsg = e.message || (typeof e === 'string' ? e : JSON.stringify(e)) || "Unknown recorder error";
      setError("Failed to initialize MediaRecorder: " + errorMsg);
    }
  }, [stream, mode]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsProcessingUpload(true);
    try {
      const videoEl = document.createElement('video');
      const url = URL.createObjectURL(file);
      videoEl.src = url;
      videoEl.muted = true;
      videoEl.crossOrigin = 'anonymous';

      await new Promise<void>((resolve, reject) => {
        videoEl.onloadedmetadata = () => resolve();
        videoEl.onerror = () => reject(new Error('Could not load video file'));
        setTimeout(() => reject(new Error('Video load timed out')), 15000);
      });

      const duration = Math.round(videoEl.duration) || 1;
      const uploadedSnapshots: string[] = [];
      const snapshotCount = Math.min(12, Math.max(3, Math.floor(duration / 5)));

      for (let i = 0; i < snapshotCount; i++) {
        const seekTime = (duration / snapshotCount) * i + 0.1;
        await new Promise<void>((resolve) => {
          videoEl.currentTime = seekTime;
          videoEl.onseeked = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 180;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(videoEl, 0, 0, 320, 180);
              const base64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
              uploadedSnapshots.push(base64);
            }
            resolve();
          };
        });
      }

      URL.revokeObjectURL(url);
      onSessionComplete(file, clientName || 'Client', mode, uploadedSnapshots, duration);
    } catch (err: any) {
      setError('Upload failed: ' + (err.message || 'Unknown error'));
    } finally {
      setIsProcessingUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [clientName, mode, onSessionComplete]);

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="max-w-4xl mx-auto bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-200">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleFileUpload}
      />
      <div className="bg-slate-900 p-6 flex items-center justify-between text-white">
        <div>
          <h2 className="font-black text-sm uppercase tracking-widest text-brand-400 italic">
            {mode === 'clip' ? 'Precision Technique' : mode === 'workout30' ? '30m Audit' : '60m Endurance'}
          </h2>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tighter">
            {recording ? `Recording Live · ${snapshots.length} Samples` : 'Camera Standby'}
          </p>
        </div>
        <div className="font-mono text-2xl tabular-nums bg-slate-800 px-4 py-1 rounded-xl border border-slate-700">{formatTime(timer)}</div>
      </div>

      <div className="relative aspect-video bg-black flex flex-col items-center justify-center">
        {/* Video element is ALWAYS in the DOM — never unmounted during lens switch */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={`absolute inset-0 w-full h-full object-cover opacity-90 ${stream ? 'block' : 'hidden'}`}
        />

        {/* Lens switching overlay — shows brief indicator while changing cameras */}
        {isSwitchingLens && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/30">
            <div className="bg-black/60 backdrop-blur-sm rounded-2xl px-6 py-3">
              <span className="text-white text-xs font-black uppercase tracking-widest animate-pulse">Switching...</span>
            </div>
          </div>
        )}

        {/* Camera starting slow indicator */}
        {cameraStartingSlow && !stream && !error && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-center space-y-2">
              <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-white text-xs font-bold">Starting camera...</p>
              <p className="text-slate-500 text-[10px]">This may take a moment</p>
            </div>
          </div>
        )}

        {/* Activate camera placeholder — only when no stream and not switching */}
        {!stream && !isSwitchingLens && !cameraStartingSlow && (
          <div className="z-10 text-center space-y-4 p-8">
            <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <svg className="w-8 h-8 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h3 className="text-white font-black uppercase tracking-widest text-lg">Camera Access Required</h3>
            <p className="text-slate-400 text-xs font-medium max-w-xs mx-auto">
              To start recording, we need access to your camera and microphone.
            </p>
            <button
              onClick={() => {
                console.log('Activate Camera tapped');
                startCamera(facingMode);
              }}
              className="mt-4 px-8 py-3 bg-brand-500 text-white font-black uppercase tracking-widest text-xs rounded-xl shadow-lg shadow-brand-500/30 hover:bg-brand-400 transition-all active:scale-95"
            >
              Activate Camera
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessingUpload}
              className="mt-2 px-8 py-3 bg-slate-700 text-white font-black uppercase tracking-widest text-xs rounded-xl hover:bg-slate-600 transition-all active:scale-95 disabled:opacity-50"
            >
              {isProcessingUpload ? 'Processing…' : 'Upload Video'}
            </button>
          </div>
        )}

        {/* Camera flip button (front/back toggle) */}
        {!recording && stream && (
          <button
            onClick={toggleCamera}
            className="absolute bottom-6 right-6 p-4 bg-white/10 hover:bg-white/20 backdrop-blur-xl border border-white/20 rounded-2xl text-white transition-all active:scale-90 z-20"
            title="Switch Front/Back Camera"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        )}

        {/* Lens selector pill (only when multiple rear cameras exist and not recording) */}
        {!recording && stream && facingMode === 'environment' && availableCameras.filter(c => c.kind !== 'front').length > 1 && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/40 backdrop-blur-xl rounded-full px-1.5 py-1 border border-white/20 z-20">
            {availableCameras
              .filter(c => c.kind !== 'front')
              .map(camera => {
                const isActive = camera.deviceId === selectedCameraId;
                const label = camera.kind === 'ultrawide' ? '0.5x'
                  : camera.kind === 'wide' ? '1x'
                  : camera.kind === 'telephoto' ? '2x'
                  : '?';
                return (
                  <button
                    key={camera.deviceId}
                    onClick={() => startCamera('environment', camera.deviceId)}
                    className={`min-w-[40px] min-h-[40px] rounded-full flex items-center justify-center text-xs font-black transition-all ${
                      isActive
                        ? 'bg-brand-500 text-white scale-110 shadow-lg'
                        : 'text-white/70 active:bg-white/10'
                    }`}
                    title={camera.label}
                  >
                    {label}
                  </button>
                );
              })}
          </div>
        )}

        {recording && (
          <>
            <div className="absolute top-6 right-6 flex items-center gap-2 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 z-20">
              <div className="w-2 h-2 bg-red-600 rounded-full animate-pulse"></div>
              <span className="text-[9px] font-black text-white uppercase tracking-widest">Live</span>
            </div>
            {/* End Session button overlaid on video during recording */}
            <button
              onClick={() => { mediaRecorderRef.current?.stop(); setRecording(false); onRecordingStateChange?.(false); }}
              className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-red-600/90 backdrop-blur-xl text-white font-black px-8 py-3 rounded-full active:scale-95 transition-all uppercase text-[10px] tracking-widest border border-white/20 shadow-lg z-20"
            >
              End Session
            </button>
          </>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/95 p-10 text-center z-30">
            <div className="space-y-6 max-w-sm">
              <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center mx-auto text-red-500">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h4 className="text-white text-sm font-black uppercase tracking-widest mb-2">Connection Issue</h4>
                <p className="text-slate-400 text-xs font-medium leading-relaxed">
                  {error}
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => {
                    setError(null);
                    setSelectedCameraId(null);
                    camerasEnumeratedRef.current = false;
                    // Fresh start — don't re-use failed deviceId
                    startCamera(facingMode);
                  }}
                  className="w-full bg-brand-500 text-white px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-brand-400"
                >
                  Retry Camera
                </button>
                <button
                    onClick={() => setError(null)}
                    className="w-full bg-slate-800 text-slate-400 px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest hover:text-white"
                >
                    Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Controls below video — hidden during recording for full-screen camera view */}
      {!recording ? (
        <div className="p-6 space-y-6">
          {/* Mic selector + Audio level meter */}
          {stream && (
            <div className="space-y-3">
              {availableMics.length > 1 && (
                <div className="flex items-center gap-3">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">
                    <svg className="w-4 h-4 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    Mic
                  </label>
                  <select
                    value={selectedMicId || ''}
                    onChange={(e) => handleMicChange(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-xs font-medium outline-none focus:ring-2 focus:ring-brand-100 bg-white truncate"
                  >
                    {availableMics.map((mic, i) => (
                      <option key={mic.deviceId} value={mic.deviceId}>
                        {mic.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {/* Audio level bar */}
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-75 ${
                      audioLevel > 0.6 ? 'bg-gradient-to-r from-green-400 to-yellow-400' :
                      audioLevel > 0.02 ? 'bg-gradient-to-r from-green-400 to-green-500' :
                      'bg-slate-200'
                    }`}
                    style={{ width: `${Math.min(100, audioLevel * 200)}%` }}
                  />
                </div>
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest w-12 text-right">
                  {audioLevel > 0.02 ? 'Live' : 'Silent'}
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            {[
              { id: 'clip', label: 'Clip', desc: '< 5 mins' },
              { id: 'workout30', label: '30m', desc: 'Audit' },
              { id: 'workout60', label: '60m', desc: 'Audit' }
            ].map(m => (
              <button
                key={m.id}
                onClick={() => setMode(m.id as SessionMode)}
                className={`p-4 rounded-2xl border-2 transition-all text-center ${mode === m.id ? 'border-brand-500 bg-brand-50 ring-4 ring-brand-50' : 'border-slate-100 bg-white hover:border-slate-200'}`}
              >
                <div className={`text-xs font-black uppercase ${mode === m.id ? 'text-brand-500' : 'text-slate-400'}`}>{m.label}</div>
                <div className="text-[8px] font-bold text-slate-400 mt-1 uppercase tracking-tighter">{m.desc}</div>
              </button>
            ))}
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-400 uppercase mb-2 block tracking-widest">Athlete Profile</label>
            <input
              type="text"
              placeholder="e.g. David Goggins"
              value={clientName}
              onChange={e => setClientName(e.target.value)}
              className="w-full px-5 py-4 rounded-2xl border border-slate-200 text-sm outline-none focus:ring-4 focus:ring-brand-100 transition-all placeholder:text-slate-300 font-medium"
            />
          </div>

          <div className="flex gap-4">
            <button
              onClick={startRecording}
              disabled={!!error || !stream}
              className="flex-1 bg-brand-500 text-white font-black py-5 rounded-2xl shadow-xl shadow-brand-100 hover:bg-brand-600 active:scale-95 transition-all uppercase text-xs tracking-[0.2em] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Start Recording
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessingUpload}
              className="flex-1 bg-slate-800 text-white font-black py-5 rounded-2xl hover:bg-slate-700 active:scale-95 transition-all uppercase text-xs tracking-[0.2em] disabled:opacity-50"
            >
              {isProcessingUpload ? 'Processing…' : 'Upload Video'}
            </button>
          </div>

          {chunks.length > 0 && (
            <button
              onClick={() => onSessionComplete(new Blob(chunks, { type: mediaRecorderRef.current?.mimeType }), clientName || 'Client', mode, snapshots, timer)}
              className="w-full bg-green-600 text-white font-black py-5 rounded-2xl shadow-xl shadow-green-100 active:scale-95 transition-all uppercase text-xs tracking-[0.2em]"
            >
              Run AI Report
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
};

export default Recorder;
