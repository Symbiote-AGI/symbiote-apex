import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Mic, Send, Volume2, X } from 'lucide-react';
import {
  audioBlobToBase64,
  analyzePcmWav,
  combinePcmWav,
  createPcmWavRecorder,
  disposePcmWavRecorderSetup,
  preparePcmWavRecorder,
  tailPcmWav,
  type PcmWavRecorder,
  type PcmWavRecorderSetup,
} from '../lib/voice-recorder';
import { extractWakeCommand, isSpeechConfidenceSufficient, splitTrailingSendCommand } from './voice-wake-word';

type Request = <T>(endpoint: string, options?: RequestInit) => Promise<T>;
type AudioRequest = (endpoint: string, options?: RequestInit) => Promise<Blob>;
type VoiceStyle = 'natural' | 'robotic' | 'alien';
type VoiceTranscriptionMode = 'dictation' | 'wake';
type SpeechVoiceOption = {
  id: string;
  label: string;
  language: string;
  engine: 'windows-sapi' | 'browser';
};
type SpeechCapabilities = {
  transcriptionAvailable: boolean;
  recognitionEngine: 'vosk' | 'windows-sapi' | null;
  synthesisAvailable: boolean;
  voices: SpeechVoiceOption[];
};
export type MicrophoneStatus = 'idle' | 'requesting' | 'connected' | 'audio-paused' | 'denied' | 'unsupported' | 'error';
export interface MicrophoneAudioAnalysis {
  context: AudioContext;
  analyser: AnalyserNode;
  frequencies: Uint8Array<ArrayBuffer>;
}

interface ActiveMicrophoneAudioAnalysis extends MicrophoneAudioAnalysis {
  source: MediaStreamAudioSourceNode;
  output: GainNode;
  onStateChange: () => void;
}

interface ChatVoiceContextValue {
  agentName: string;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  wakeWordEnabled: boolean;
  setWakeWordEnabled: (enabled: boolean) => void;
  talkBack: boolean;
  setTalkBack: (enabled: boolean) => void;
  recognitionAvailable: boolean;
  recognitionEngine: SpeechCapabilities['recognitionEngine'];
  speechAvailable: boolean;
  voices: SpeechVoiceOption[];
  selectedVoiceName: string;
  setSelectedVoiceName: (name: string) => void;
  voiceStyle: VoiceStyle;
  setVoiceStyle: (style: VoiceStyle) => void;
  rate: number;
  setRate: (rate: number) => void;
  pitch: number;
  setPitch: (pitch: number) => void;
  volume: number;
  setVolume: (volume: number) => void;
  microphoneStatus: MicrophoneStatus;
  microphoneError: string;
  audioAnalysis: MicrophoneAudioAnalysis | null;
  requestMicrophoneAccess: () => Promise<MediaStream | null>;
  disconnectMicrophone: () => void;
  recording: boolean;
  recordingStream: MediaStream | null;
  transcribing: boolean;
  voiceNotice: string;
  voiceError: string;
  startRecording: (setup?: PcmWavRecorderSetup) => Promise<void>;
  stopRecording: (onTranscript?: (transcript: string) => void) => void;
}

const ChatVoiceContext = createContext<ChatVoiceContextValue | null>(null);

const MICROPHONE_UNAVAILABLE_MESSAGE = 'Microphone access requires HTTPS or localhost and a browser with microphone and audio support.';
const MICROPHONE_AUDIO_PAUSED_MESSAGE = 'Microphone connected, but browser audio processing is paused. Select Resume to restore live orb response.';

function spokenText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function canCaptureAudio(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && Boolean(audioContextConstructor());
}

function audioContextIsRunning(context: AudioContext): boolean {
  return context.state === 'running';
}

function microphoneFailureMessage(failure: unknown): string {
  if (!(failure instanceof Error)) return 'Microphone access could not be started.';
  switch (failure.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone permission was denied. Allow microphone access in browser settings, then retry.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone input device was found.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is busy or unavailable. Close other apps using it and retry.';
    case 'SecurityError':
      return MICROPHONE_UNAVAILABLE_MESSAGE;
    default:
      return failure.message || 'Microphone access could not be started.';
  }
}

function microphoneFailureStatus(failure: unknown): MicrophoneStatus {
  if (failure instanceof Error && ['NotAllowedError', 'PermissionDeniedError'].includes(failure.name)) return 'denied';
  return 'error';
}

function browserSpeechVoices(): SpeechVoiceOption[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices().map(voice => ({
    id: `browser:${voice.name}`,
    label: `${voice.name} · ${voice.lang}`,
    language: voice.lang,
    engine: 'browser',
  }));
}

function useChatVoice(): ChatVoiceContextValue {
  const context = useContext(ChatVoiceContext);
  if (!context) throw new Error('Chat voice controls must be used inside ChatVoiceProvider.');
  return context;
}

export function useChatVoiceAudioStream(): MediaStream | null {
  return useContext(ChatVoiceContext)?.recordingStream ?? null;
}

export function useChatVoiceAudioAnalysis(): MicrophoneAudioAnalysis | null {
  return useContext(ChatVoiceContext)?.audioAnalysis ?? null;
}

export function ChatVoiceProvider({
  request,
  requestAudio,
  agentName,
  latestAssistantMessage,
  onDictation,
  onWakeWord,
  onHandsFreeDictation,
  onHandsFreeSend,
  children,
}: {
  request: Request;
  requestAudio: AudioRequest;
  agentName: string;
  latestAssistantMessage?: { id: string; content: string };
  onDictation: (transcript: string) => void;
  onWakeWord: () => Promise<string | undefined>;
  onHandsFreeDictation: (sessionId: string, transcript: string) => void;
  onHandsFreeSend: (sessionId: string, transcript: string) => boolean;
  children: ReactNode;
}) {
  const audioCaptureAvailable = canCaptureAudio();
  const [menuOpen, setMenuOpen] = useState(false);
  const [wakeWordEnabled, setWakeWordEnabledState] = useState(false);
  const [talkBack, setTalkBack] = useState(false);
  const [voiceCapabilities, setVoiceCapabilities] = useState<SpeechCapabilities | null>(null);
  const [browserVoices, setBrowserVoices] = useState<SpeechVoiceOption[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState('');
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyle>('natural');
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [volume, setVolume] = useState(1);
  const [microphoneStatus, setMicrophoneStatus] = useState<MicrophoneStatus>(
    audioCaptureAvailable ? 'idle' : 'unsupported',
  );
  const [microphoneError, setMicrophoneError] = useState(
    audioCaptureAvailable ? '' : MICROPHONE_UNAVAILABLE_MESSAGE,
  );
  const [audioAnalysis, setAudioAnalysis] = useState<MicrophoneAudioAnalysis | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const recorderRef = useRef<PcmWavRecorder | null>(null);
  const wakeWordRecorderSetupRef = useRef<PcmWavRecorderSetup | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneRequestRef = useRef<Promise<MediaStream | null> | null>(null);
  const audioAnalysisRef = useRef<ActiveMicrophoneAudioAnalysis | null>(null);
  const microphoneErrorRef = useRef(microphoneError);
  const recordingRequestRef = useRef(0);
  const handsFreeSessionIdRef = useRef('');
  const handsFreeDraftRef = useRef('');
  const handsFreeActiveRef = useRef(false);
  const pendingSendRef = useRef(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(request);
  const requestAudioRef = useRef(requestAudio);
  const onDictationRef = useRef(onDictation);
  const onWakeWordRef = useRef(onWakeWord);
  const onHandsFreeDictationRef = useRef(onHandsFreeDictation);
  const onHandsFreeSendRef = useRef(onHandsFreeSend);
  const agentNameRef = useRef(agentName);
  const lastAssistantMessageIdRef = useRef<string | null>(null);
  const firstAssistantObservationRef = useRef(true);
  const audioPlaybackRef = useRef<HTMLAudioElement | null>(null);
  const playbackObjectUrlRef = useRef<string | null>(null);

  requestRef.current = request;
  requestAudioRef.current = requestAudio;
  onDictationRef.current = onDictation;
  onWakeWordRef.current = onWakeWord;
  onHandsFreeDictationRef.current = onHandsFreeDictation;
  onHandsFreeSendRef.current = onHandsFreeSend;
  agentNameRef.current = agentName;

  const setWakeWordEnabled = useCallback((enabled: boolean) => {
    if (enabled === wakeWordEnabled) return;
    if (enabled) {
      try {
        wakeWordRecorderSetupRef.current = preparePcmWavRecorder();
        setVoiceError('');
      } catch (failure) {
        setVoiceError(failure instanceof Error ? failure.message : 'Local wake-word audio could not be prepared.');
        return;
      }
    } else {
      const setup = wakeWordRecorderSetupRef.current;
      wakeWordRecorderSetupRef.current = null;
      if (setup) {
        void disposePcmWavRecorderSetup(setup).catch(failure => {
          console.warn('[voice] Wake-word audio context cleanup failed:', failure);
        });
      }
    }
    setWakeWordEnabledState(enabled);
  }, [wakeWordEnabled]);

  const voices = useMemo(
    () => voiceCapabilities?.voices.length ? voiceCapabilities.voices : browserVoices,
    [browserVoices, voiceCapabilities],
  );
  microphoneErrorRef.current = microphoneError;
  const recognitionAvailable = Boolean(voiceCapabilities?.transcriptionAvailable && audioCaptureAvailable);
  const speechAvailable = Boolean(voiceCapabilities?.synthesisAvailable || browserVoices.length);

  const updateMicrophoneError = useCallback((message: string) => {
    microphoneErrorRef.current = message;
    setMicrophoneError(message);
  }, []);

  const closeAudioAnalysis = useCallback(() => {
    const active = audioAnalysisRef.current;
    audioAnalysisRef.current = null;
    if (mountedRef.current) setAudioAnalysis(null);
    if (!active) return;

    active.context.removeEventListener('statechange', active.onStateChange);
    active.source.disconnect();
    active.analyser.disconnect();
    active.output.disconnect();
    if (active.context.state !== 'closed') {
      void active.context.close().catch(failure => console.warn('[voice] Audio analysis cleanup failed:', failure));
    }
  }, []);

  const connectAudioAnalysis = useCallback((stream: MediaStream) => {
    const AudioContextConstructor = audioContextConstructor();
    if (!AudioContextConstructor) throw new Error(MICROPHONE_UNAVAILABLE_MESSAGE);

    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let output: GainNode | null = null;
    let connection: ActiveMicrophoneAudioAnalysis | null = null;

    try {
      context = new AudioContextConstructor({ latencyHint: 'interactive' });
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      output = context.createGain();
      output.gain.value = 0;
      source.connect(analyser);
      analyser.connect(output);
      output.connect(context.destination);

      const activeContext = context;
      const activeAnalyser = analyser;
      const activeSource = source;
      const activeOutput = output;
      const onStateChange = () => {
        if (audioAnalysisRef.current !== connection || microphoneStreamRef.current !== stream) return;
        if (activeContext.state === 'running') {
          setMicrophoneStatus('connected');
          updateMicrophoneError('');
        } else if (activeContext.state === 'suspended') {
          setMicrophoneStatus('audio-paused');
          updateMicrophoneError(MICROPHONE_AUDIO_PAUSED_MESSAGE);
        } else {
          setMicrophoneStatus('error');
          updateMicrophoneError('The browser closed the microphone audio connection. Retry to reconnect it.');
        }
      };

      connection = {
        context: activeContext,
        analyser: activeAnalyser,
        frequencies: new Uint8Array(activeAnalyser.frequencyBinCount),
        source: activeSource,
        output: activeOutput,
        onStateChange,
      };
      activeContext.addEventListener('statechange', onStateChange);
    } catch (failure) {
      source?.disconnect();
      analyser?.disconnect();
      output?.disconnect();
      if (context && context.state !== 'closed') {
        void context.close().catch(closeFailure => console.warn('[voice] Failed to close an incomplete audio connection:', closeFailure));
      }
      throw failure;
    }

    if (!connection) throw new Error('The microphone audio analyzer could not be created.');
    audioAnalysisRef.current = connection;
    setAudioAnalysis(connection);

    if (connection.context.state === 'running') {
      setMicrophoneStatus('connected');
      updateMicrophoneError('');
    } else if (connection.context.state === 'suspended') {
      setMicrophoneStatus('audio-paused');
      updateMicrophoneError(MICROPHONE_AUDIO_PAUSED_MESSAGE);
      void connection.context.resume().catch(failure => {
        if (audioAnalysisRef.current !== connection) return;
        setMicrophoneStatus('audio-paused');
        updateMicrophoneError(`Microphone is connected, but browser audio could not resume: ${failure instanceof Error ? failure.message : String(failure)}`);
      });
    }
  }, [updateMicrophoneError]);

  const requestMicrophoneAccess = useCallback(async (): Promise<MediaStream | null> => {
    if (!audioCaptureAvailable) {
      setMicrophoneStatus('unsupported');
      updateMicrophoneError(MICROPHONE_UNAVAILABLE_MESSAGE);
      return null;
    }

    const existingStream = microphoneStreamRef.current;
    const hasLiveAudioTrack = existingStream?.getAudioTracks().some(track => track.readyState === 'live') ?? false;
    if (existingStream?.active && hasLiveAudioTrack) {
      const active = audioAnalysisRef.current;
      if (active?.context.state === 'running') {
        setMicrophoneStatus('connected');
        updateMicrophoneError('');
        return existingStream;
      }

      setMicrophoneStatus('requesting');
      if (active?.context.state === 'suspended') {
        try {
          await active.context.resume();
          if (!mountedRef.current || audioAnalysisRef.current !== active) return existingStream;
          if (audioContextIsRunning(active.context)) {
            setMicrophoneStatus('connected');
            updateMicrophoneError('');
          } else {
            setMicrophoneStatus('audio-paused');
            updateMicrophoneError(MICROPHONE_AUDIO_PAUSED_MESSAGE);
          }
        } catch (failure) {
          if (!mountedRef.current || audioAnalysisRef.current !== active) return existingStream;
          setMicrophoneStatus('audio-paused');
          updateMicrophoneError(`Microphone is connected, but browser audio could not resume: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
        return existingStream;
      }

      if (active) closeAudioAnalysis();
      try {
        connectAudioAnalysis(existingStream);
      } catch (failure) {
        setMicrophoneStatus('error');
        updateMicrophoneError(`Microphone is connected, but orb audio analysis could not start: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      return existingStream;
    }

    if (existingStream) {
      microphoneStreamRef.current = null;
      closeAudioAnalysis();
      existingStream.getTracks().forEach(track => track.stop());
    }

    if (microphoneRequestRef.current) return microphoneRequestRef.current;

    setMicrophoneStatus('requesting');
    updateMicrophoneError('');
    const request = (async (): Promise<MediaStream | null> => {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!mountedRef.current) {
          stream.getTracks().forEach(track => track.stop());
          return null;
        }
        if (!stream.getAudioTracks().some(track => track.readyState === 'live')) {
          throw new Error('The selected input did not provide a live audio track.');
        }

        microphoneStreamRef.current = stream;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => {
            if (microphoneStreamRef.current !== stream) return;
            if (stream?.getAudioTracks().some(audioTrack => audioTrack.readyState === 'live')) return;
            microphoneStreamRef.current = null;
            closeAudioAnalysis();
            setMicrophoneStatus('error');
            updateMicrophoneError('The microphone connection ended. Reconnect it to restore live orb audio.');
          }, { once: true });
        }

        try {
          connectAudioAnalysis(stream);
        } catch (failure) {
          setMicrophoneStatus('error');
          updateMicrophoneError(`Microphone is connected, but orb audio analysis could not start: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
        return stream;
      } catch (failure) {
        if (stream) {
          if (microphoneStreamRef.current === stream) microphoneStreamRef.current = null;
          stream.getTracks().forEach(track => track.stop());
          closeAudioAnalysis();
        }
        setMicrophoneStatus(microphoneFailureStatus(failure));
        updateMicrophoneError(microphoneFailureMessage(failure));
        return null;
      }
    })();

    microphoneRequestRef.current = request;
    try {
      return await request;
    } finally {
      if (microphoneRequestRef.current === request) microphoneRequestRef.current = null;
    }
  }, [audioCaptureAvailable, closeAudioAnalysis, connectAudioAnalysis, updateMicrophoneError]);

  const disconnectMicrophone = useCallback(() => {
    if (recording || wakeWordEnabled) return;
    const stream = microphoneStreamRef.current;
    microphoneStreamRef.current = null;
    closeAudioAnalysis();
    stream?.getTracks().forEach(track => track.stop());
    setMicrophoneStatus(audioCaptureAvailable ? 'idle' : 'unsupported');
    updateMicrophoneError(audioCaptureAvailable ? '' : MICROPHONE_UNAVAILABLE_MESSAGE);
  }, [audioCaptureAvailable, closeAudioAnalysis, recording, updateMicrophoneError, wakeWordEnabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recordingRequestRef.current++;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        void recorder.stop().catch(failure => console.warn('[voice] Audio recorder cleanup failed:', failure));
      }
      const wakeWordSetup = wakeWordRecorderSetupRef.current;
      wakeWordRecorderSetupRef.current = null;
      if (wakeWordSetup) {
        void disposePcmWavRecorderSetup(wakeWordSetup).catch(failure => {
          console.warn('[voice] Wake-word audio context cleanup failed:', failure);
        });
      }
      const stream = microphoneStreamRef.current;
      microphoneStreamRef.current = null;
      closeAudioAnalysis();
      stream?.getTracks().forEach(track => track.stop());
      const audio = audioPlaybackRef.current;
      audioPlaybackRef.current = null;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      const objectUrl = playbackObjectUrlRef.current;
      playbackObjectUrlRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [closeAudioAnalysis]);

  useEffect(() => {
    let disposed = false;
    void requestRef.current<SpeechCapabilities>('/api/voice/status')
      .then(capabilities => {
        if (disposed) return;
        setVoiceCapabilities(capabilities);
      })
      .catch(failure => {
        if (!disposed) setVoiceError(`Local voice service is unavailable: ${failure instanceof Error ? failure.message : String(failure)}`);
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const updateVoices = () => setBrowserVoices(browserSpeechVoices());
    updateVoices();
    window.speechSynthesis.addEventListener('voiceschanged', updateVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', updateVoices);
  }, []);

  useEffect(() => {
    if (voices.length && !voices.some(voice => voice.id === selectedVoiceName)) {
      setSelectedVoiceName(voices[0].id);
    }
  }, [selectedVoiceName, voices]);

  const transcribeAudioBlob = useCallback(async (
    audio: Blob,
    mode: VoiceTranscriptionMode = 'dictation',
  ): Promise<{ text: string; confidence?: number }> => {
    if (audio.size <= 44) throw new Error('No speech was detected in the recording.');
    if (audio.size > 8 * 1024 * 1024) throw new Error('Keep recordings under 8 MB, then try again.');
    const audioBase64 = await audioBlobToBase64(audio);
    const wakeAgentName = agentNameRef.current.trim();
    const result = await requestRef.current<{ text: string; confidence?: number }>('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify({
        audioBase64,
        mimeType: 'audio/wav',
        mode,
        ...(mode === 'wake' ? {
          agentName: wakeAgentName && wakeAgentName.length <= 80 ? wakeAgentName : 'Agent',
        } : {}),
      }),
    });
    if (typeof result.confidence === 'number' && !isSpeechConfidenceSufficient(result.confidence)) {
      throw new Error(`Speech recognition was uncertain (${Math.round(result.confidence * 100)}% confidence); nothing was added. Please repeat.`);
    }
    return {
      text: result.text.trim(),
      ...(typeof result.confidence === 'number' ? { confidence: result.confidence } : {}),
    };
  }, []);

  useEffect(() => {
    if (!wakeWordEnabled || recording) {
      if (!wakeWordEnabled) {
        handsFreeSessionIdRef.current = '';
        handsFreeDraftRef.current = '';
        handsFreeActiveRef.current = false;
        pendingSendRef.current = false;
      }
      return;
    }
    if (!recognitionAvailable) {
      setVoiceError(audioCaptureAvailable
        ? 'Local speech recognition is not available.'
        : 'Microphone access requires HTTPS or localhost and a supported browser.');
      setWakeWordEnabled(false);
      return;
    }

    let recorderSetup = wakeWordRecorderSetupRef.current;
    wakeWordRecorderSetupRef.current = null;
    if (!recorderSetup) {
      try {
        recorderSetup = preparePcmWavRecorder();
      } catch (failure) {
        setVoiceError(failure instanceof Error ? failure.message : 'Local wake-word audio could not be prepared.');
        setWakeWordEnabled(false);
        return;
      }
    }
    const activeRecorderSetup = recorderSetup;

    setVoiceError('');
    const wakePhrase = `Hey ${agentName || 'Agent'}`;
    setVoiceNotice(`Listening locally for “${wakePhrase}”.`);
    let disposed = false;
    let recorder: PcmWavRecorder | null = null;
    let interval: number | undefined;
    let inFlight = false;
    let previousWords = '';
    let previousWakeAudio: Blob | null = null;
    let lastSpeechAt = 0;

    const returnToWakeListening = (notice: string) => {
      handsFreeSessionIdRef.current = '';
      handsFreeDraftRef.current = '';
      handsFreeActiveRef.current = false;
      pendingSendRef.current = false;
      previousWords = '';
      previousWakeAudio = null;
      setVoiceNotice(notice);
    };

    const sendHandsFreeDraft = () => {
      const sessionId = handsFreeSessionIdRef.current;
      const draft = handsFreeDraftRef.current.trim();
      if (!sessionId || !draft) {
        pendingSendRef.current = false;
        setVoiceNotice(`There is no message to send. Keep speaking, or say “${wakePhrase}” to start a new chat.`);
        return;
      }
      if (onHandsFreeSendRef.current(sessionId, draft)) {
        returnToWakeListening(`Message sent. Say “${wakePhrase}” to start another chat.`);
      } else {
        returnToWakeListening('The draft is saved in chat. Finish the current agent turn before sending it.');
      }
    };

    const addHandsFreeText = (sessionId: string, transcript: string) => {
      const text = transcript.trim();
      if (!text) return;
      handsFreeDraftRef.current = handsFreeDraftRef.current
        ? `${handsFreeDraftRef.current} ${text}`
        : text;
      onHandsFreeDictationRef.current(sessionId, text);
      lastSpeechAt = Date.now();
    };

    const listen = async () => {
      try {
        const stream = await requestMicrophoneAccess();
        if (!stream || disposed) {
          if (!stream && !disposed) {
            setVoiceError(microphoneErrorRef.current || 'Microphone access is required for wake-word listening.');
            setWakeWordEnabled(false);
          }
          return;
        }
        recorder = await createPcmWavRecorder(stream, activeRecorderSetup);
        recorderSetup = null;
        if (disposed) {
          await recorder.stop();
          return;
        }

        interval = window.setInterval(() => {
          if (disposed || inFlight || !recorder) return;
          const audio = recorder.take();
          if (audio.size <= 44 + 16_000) return;
          inFlight = true;
          void (async () => {
            let chunkRms = 0;
            try {
              const mode = handsFreeActiveRef.current ? 'dictation' : 'wake';
              let transcriptionAudio = audio;
              if (mode === 'wake') {
                if (previousWakeAudio) transcriptionAudio = await combinePcmWav(previousWakeAudio, audio);
                previousWakeAudio = await tailPcmWav(transcriptionAudio, 1_500);
              }
              const audioAnalysis = await analyzePcmWav(transcriptionAudio);
              chunkRms = audioAnalysis.rms;
              if (disposed) return;
              if (handsFreeActiveRef.current && Date.now() - lastSpeechAt > 60_000) {
                returnToWakeListening(`Your draft is saved in chat. Say “${wakePhrase}” when you are ready to continue.`);
                return;
              }
              if (audioAnalysis.rms < 0.0015) {
                if (handsFreeActiveRef.current && pendingSendRef.current) {
                  sendHandsFreeDraft();
                }
                return;
              }

              const result = await transcribeAudioBlob(transcriptionAudio, mode);
              if (!result.text || disposed) return;
              if (!handsFreeActiveRef.current) {
                const combinedTranscript = `${previousWords} ${result.text}`.trim();
                const wakeCommand = extractWakeCommand(combinedTranscript, agentNameRef.current);
                if (wakeCommand === null) {
                  previousWords = combinedTranscript.split(/\s+/).slice(-3).join(' ');
                  return;
                }
                previousWords = '';
                previousWakeAudio = null;
                const sessionId = await onWakeWordRef.current();
                if (!sessionId || disposed) {
                  setVoiceNotice('A new chat could not be opened. Check the Control Room connection and try again.');
                  return;
                }
                handsFreeSessionIdRef.current = sessionId;
                handsFreeDraftRef.current = '';
                handsFreeActiveRef.current = true;
                pendingSendRef.current = false;
                lastSpeechAt = Date.now();
                setVoiceNotice(`New chat ready. Speak your message, then say “send” to submit it.`);
                return;
              }

              const sessionId = handsFreeSessionIdRef.current;
              if (!sessionId) {
                returnToWakeListening(`Listening locally for “${wakePhrase}”.`);
                return;
              }
              const sendCommand = splitTrailingSendCommand(result.text);
              if (pendingSendRef.current && result.text) {
                addHandsFreeText(sessionId, 'send');
                pendingSendRef.current = false;
              }
              addHandsFreeText(sessionId, sendCommand.text);
              if (sendCommand.send) {
                if (!handsFreeDraftRef.current.trim()) {
                  setVoiceNotice('There is no message to send. Speak your message first.');
                } else if (audioAnalysis.trailingSilenceMs >= 800) {
                  sendHandsFreeDraft();
                } else {
                  pendingSendRef.current = true;
                  setVoiceNotice('Ready to send. Pausing briefly to confirm…');
                }
              } else if (handsFreeActiveRef.current) {
                setVoiceNotice('Listening. Say “send” when your message is ready to submit.');
              }
            } catch (failure) {
              const message = failure instanceof Error ? failure.message : String(failure);
              if (message.includes('No speech was detected')) {
                if (handsFreeActiveRef.current && pendingSendRef.current) {
                  sendHandsFreeDraft();
                } else if (chunkRms >= 0.0015) {
                  setVoiceNotice('Sound reached local speech recognition, but it returned no words. Check the microphone and try again.');
                }
                return;
              }
              if (message.includes('Speech recognition was uncertain')) {
                if (!disposed) setVoiceNotice(message);
                return;
              }
              if (!disposed) {
                setVoiceError(`Wake-word listening failed: ${message}`);
                setWakeWordEnabled(false);
              }
            } finally {
              inFlight = false;
            }
          })();
        }, 5_000);
      } catch (failure) {
        if (disposed) return;
        setVoiceError(failure instanceof Error ? failure.message : 'Local wake-word listening could not start.');
        setWakeWordEnabled(false);
      }
    };

    void listen();
    return () => {
      disposed = true;
      if (interval !== undefined) window.clearInterval(interval);
      handsFreeSessionIdRef.current = '';
      handsFreeDraftRef.current = '';
      handsFreeActiveRef.current = false;
      pendingSendRef.current = false;
      if (recorder) {
        void recorder.stop().catch(failure => console.warn('[voice] Wake-word recorder cleanup failed:', failure));
      }
      if (recorderSetup) {
        void disposePcmWavRecorderSetup(recorderSetup).catch(failure => {
          console.warn('[voice] Wake-word audio context cleanup failed:', failure);
        });
      }
    };
  }, [agentName, audioCaptureAvailable, recognitionAvailable, recording, requestMicrophoneAccess, transcribeAudioBlob, wakeWordEnabled]);

  useEffect(() => {
    const message = latestAssistantMessage;
    if (firstAssistantObservationRef.current) {
      firstAssistantObservationRef.current = false;
      lastAssistantMessageIdRef.current = message?.id ?? null;
      return;
    }
    if (!message || message.id === lastAssistantMessageIdRef.current) return;
    lastAssistantMessageIdRef.current = message.id;
    if (!talkBack || !speechAvailable) return;

    const text = spokenText(message.content);
    if (!text) return;
    if (voiceCapabilities?.synthesisAvailable) {
      let disposed = false;
      let audio: HTMLAudioElement | null = null;
      let objectUrl: string | null = null;
      const cleanup = () => {
        if (audio) {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
          if (audioPlaybackRef.current === audio) audioPlaybackRef.current = null;
        }
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          if (playbackObjectUrlRef.current === objectUrl) playbackObjectUrlRef.current = null;
          objectUrl = null;
        }
      };
      void (async () => {
        try {
          const response = await requestAudioRef.current('/api/voice/synthesize', {
            method: 'POST',
            body: JSON.stringify({ text, voiceId: selectedVoiceName, rate, pitch, volume, style: voiceStyle }),
          });
          if (disposed) return;
          objectUrl = URL.createObjectURL(response);
          playbackObjectUrlRef.current = objectUrl;
          audio = new Audio(objectUrl);
          audioPlaybackRef.current = audio;
          audio.onended = cleanup;
          audio.onerror = () => {
            setVoiceError('Local Microsoft speech playback failed.');
            cleanup();
          };
          await audio.play();
        } catch (failure) {
          if (!disposed) setVoiceError(failure instanceof Error ? failure.message : 'Local speech playback failed.');
          cleanup();
        }
      })();
      return () => {
        disposed = true;
        cleanup();
      };
    }

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const browserVoiceName = selectedVoiceName.startsWith('browser:') ? selectedVoiceName.slice('browser:'.length) : '';
    utterance.voice = window.speechSynthesis.getVoices().find(voice => voice.name === browserVoiceName) ?? null;
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    utterance.onerror = event => setVoiceError(`Speech playback failed: ${event.error}.`);
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [latestAssistantMessage?.content, latestAssistantMessage?.id, pitch, rate, selectedVoiceName, speechAvailable, talkBack, voiceCapabilities?.synthesisAvailable, voiceStyle, volume]);

  const stopRecording = useCallback((onTranscript?: (transcript: string) => void) => {
    recordingRequestRef.current++;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    setVoiceNotice('');
    if (!recorder) return;

    void (async () => {
      setTranscribing(true);
      try {
        const audio = await recorder.stop();
        if ((await analyzePcmWav(audio)).rms < 0.0015) {
          throw new Error('No microphone audio was captured. Check the selected input device and try again.');
        }
        const transcript = await transcribeAudioBlob(audio);
        if (!transcript.text) throw new Error('No speech was detected in the recording.');
        if (mountedRef.current) {
          setVoiceError('');
          (onTranscript ?? onDictationRef.current)(transcript.text);
        }
      } catch (failure) {
        if (mountedRef.current) setVoiceError(failure instanceof Error ? failure.message : 'Voice transcription failed.');
      } finally {
        if (mountedRef.current) setTranscribing(false);
      }
    })();
  }, [transcribeAudioBlob]);

  const startRecording = useCallback(async (preparedSetup?: PcmWavRecorderSetup) => {
    if (recorderRef.current || recording) {
      if (preparedSetup) {
        try {
          await disposePcmWavRecorderSetup(preparedSetup);
        } catch (failure) {
          console.warn('[voice] Unused dictation audio context cleanup failed:', failure);
        }
      }
      return;
    }
    setVoiceError('');
    setVoiceNotice('');
    const requestId = ++recordingRequestRef.current;
    let recorderSetup = preparedSetup ?? null;
    try {
      recorderSetup ??= preparePcmWavRecorder();
      const stream = await requestMicrophoneAccess();
      if (!stream) {
        if (mountedRef.current) setVoiceError(microphoneErrorRef.current || MICROPHONE_UNAVAILABLE_MESSAGE);
        return;
      }
      if (requestId !== recordingRequestRef.current) return;
      const recorder = await createPcmWavRecorder(stream, recorderSetup);
      recorderSetup = null;
      if (requestId !== recordingRequestRef.current) {
        await recorder.stop();
        return;
      }
      recorderRef.current = recorder;
      setRecording(true);
      setVoiceNotice('Recording. Release the microphone button to transcribe locally.');
    } catch (failure) {
      if (mountedRef.current) setVoiceError(failure instanceof Error ? failure.message : 'Microphone access was not available.');
    } finally {
      if (recorderSetup) {
        try {
          await disposePcmWavRecorderSetup(recorderSetup);
        } catch (failure) {
          console.warn('[voice] Dictation audio context cleanup failed:', failure);
        }
      }
    }
  }, [recording, requestMicrophoneAccess]);

  const contextValue: ChatVoiceContextValue = {
    agentName: agentName || 'Agent',
    menuOpen,
    setMenuOpen,
    wakeWordEnabled,
    setWakeWordEnabled,
    talkBack,
    setTalkBack,
    recognitionAvailable,
    recognitionEngine: voiceCapabilities?.recognitionEngine ?? null,
    speechAvailable,
    voices,
    selectedVoiceName,
    setSelectedVoiceName,
    voiceStyle,
    setVoiceStyle,
    rate,
    setRate,
    pitch,
    setPitch,
    volume,
    setVolume,
    microphoneStatus,
    microphoneError,
    audioAnalysis,
    requestMicrophoneAccess,
    disconnectMicrophone,
    recording,
    recordingStream: microphoneStreamRef.current,
    transcribing,
    voiceNotice,
    voiceError,
    startRecording,
    stopRecording,
  };

  return <ChatVoiceContext.Provider value={contextValue}>{children}</ChatVoiceContext.Provider>;
}

export function ChatVoiceMenu() {
  const voice = useChatVoice();
  const menuRef = useRef<HTMLDivElement>(null);
  const microphoneStatusText: Record<MicrophoneStatus, string> = {
    idle: 'Not connected',
    requesting: 'Requesting browser permission…',
    connected: 'Connected · live audio analysis',
    'audio-paused': 'Connected · audio processing paused',
    denied: 'Permission denied',
    unsupported: 'Unavailable on this page',
    error: 'Connection needs attention',
  };
  const microphoneButtonLabel = voice.microphoneStatus === 'requesting'
    ? 'Connecting…'
    : voice.microphoneStatus === 'connected'
      ? 'Disconnect'
      : voice.microphoneStatus === 'audio-paused'
        ? 'Resume'
        : voice.microphoneStatus === 'unsupported'
          ? 'Unavailable'
          : voice.microphoneStatus === 'denied' || voice.microphoneStatus === 'error'
            ? 'Retry'
            : 'Connect';

  useEffect(() => {
    if (!voice.menuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) voice.setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') voice.setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [voice.menuOpen, voice.setMenuOpen]);

  const updateStyle = (style: VoiceStyle) => {
    voice.setVoiceStyle(style);
    voice.setRate(1);
    voice.setPitch(1);
  };

  return (
    <div className="chat-voice-menu-anchor" ref={menuRef}>
      <button
        className={`icon-button utility-button chat-voice-menu-button${voice.wakeWordEnabled ? ' chat-voice-menu-active' : ''}`}
        type="button"
        onClick={() => voice.setMenuOpen(!voice.menuOpen)}
        aria-label="Voice controls"
        aria-haspopup="dialog"
        aria-expanded={voice.menuOpen}
        aria-controls="chat-voice-popover"
        title="Voice controls"
      ><Volume2 size={16} /></button>
      {voice.menuOpen && <section className="chat-voice-popover" id="chat-voice-popover" role="dialog" aria-label="Voice controls">
        <header><span className="eyebrow">VOICE CONTROLS</span><button className="icon-button small" type="button" onClick={() => voice.setMenuOpen(false)} aria-label="Close voice controls"><X size={14} /></button></header>
        <div className="chat-voice-microphone">
          <span><strong>Orb audio</strong><small aria-live="polite">{microphoneStatusText[voice.microphoneStatus]}</small></span>
          <button
            className="chat-voice-mic-action"
            type="button"
            onClick={() => {
              if (voice.microphoneStatus === 'connected') voice.disconnectMicrophone();
              else void voice.requestMicrophoneAccess();
            }}
            disabled={voice.microphoneStatus === 'requesting' || voice.microphoneStatus === 'unsupported' || voice.recording || voice.wakeWordEnabled}
          >{microphoneButtonLabel}</button>
          {voice.recordingStream && voice.microphoneStatus !== 'connected' && <button
            className="chat-voice-mic-action chat-voice-mic-action-secondary"
            type="button"
            onClick={voice.disconnectMicrophone}
            disabled={voice.recording || voice.wakeWordEnabled}
          >Disconnect</button>}
        </div>
        {voice.microphoneError && <p className="chat-voice-error" role="alert">{voice.microphoneError}</p>}
        <p className="chat-voice-note">The orb analyzes microphone audio in your browser. Dictation and wake-word audio are sent only to your local speech service.</p>
        <label className="chat-voice-toggle">
          <span><strong>Hey {voice.agentName}</strong><small>Open a new chat, dictate, then say “send”</small></span>
          <input type="checkbox" checked={voice.wakeWordEnabled} disabled={!voice.recognitionAvailable} onChange={event => voice.setWakeWordEnabled(event.target.checked)} />
        </label>
        <label className="chat-voice-toggle">
          <span><strong>Talk back</strong><small>Read new agent replies aloud</small></span>
          <input type="checkbox" checked={voice.talkBack} disabled={!voice.speechAvailable} onChange={event => voice.setTalkBack(event.target.checked)} />
        </label>
        <label className="chat-voice-field"><span>Voice</span>
          <select value={voice.selectedVoiceName} disabled={!voice.speechAvailable} onChange={event => voice.setSelectedVoiceName(event.target.value)}>
            {voice.voices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="chat-voice-field"><span>Voice style</span>
          <select value={voice.voiceStyle} disabled={!voice.speechAvailable} onChange={event => updateStyle(event.target.value as VoiceStyle)}>
            <option value="natural">Natural</option>
            <option value="robotic">Robotic · lower pitch</option>
            <option value="alien">Alien · higher pitch</option>
          </select>
        </label>
        <label className="chat-voice-range"><span>Speed <output>{voice.rate.toFixed(1)}×</output></span>
          <input type="range" min="0.6" max="1.6" step="0.1" value={voice.rate} disabled={!voice.speechAvailable} onChange={event => { voice.setRate(Number(event.target.value)); voice.setVoiceStyle('natural'); }} />
        </label>
        <label className="chat-voice-range"><span>Pitch <output>{voice.pitch.toFixed(1)}</output></span>
          <input type="range" min="0.5" max="2" step="0.1" value={voice.pitch} disabled={!voice.speechAvailable} onChange={event => { voice.setPitch(Number(event.target.value)); voice.setVoiceStyle('natural'); }} />
        </label>
        <label className="chat-voice-range"><span>Volume <output>{Math.round(voice.volume * 100)}%</output></span>
          <input type="range" min="0" max="1" step="0.05" value={voice.volume} disabled={!voice.speechAvailable} onChange={event => voice.setVolume(Number(event.target.value))} />
        </label>
        {voice.wakeWordEnabled && <p className="chat-voice-notice" role="status">{voice.voiceNotice || `Listening locally for “Hey ${voice.agentName}”.`}</p>}
        {!voice.recognitionAvailable && <p className="chat-voice-note">Hands-free input needs microphone access and a local speech service.</p>}
        {voice.recognitionAvailable && <p className="chat-voice-note">{voice.recognitionEngine === 'vosk' ? 'Offline Vosk transcription is active; audio stays on this device.' : 'Audio is transcribed by the local Windows speech service.'}</p>}
        {voice.voiceError && <p className="chat-voice-error" role="alert">{voice.voiceError}</p>}
      </section>}
    </div>
  );
}

export function ChatSendButton({
  disabled = false,
  className = '',
  label = 'Send message',
  onDictation,
}: {
  disabled?: boolean;
  className?: string;
  label?: string;
  onDictation?: (transcript: string) => void;
}) {
  const voice = useChatVoice();
  const holdTimerRef = useRef<number | null>(null);
  const holdTriggeredRef = useRef(false);
  const suppressClickRef = useRef(false);
  const recorderSetupRef = useRef<PcmWavRecorderSetup | null>(null);

  useEffect(() => () => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    if (holdTriggeredRef.current) voice.stopRecording();
    const setup = recorderSetupRef.current;
    recorderSetupRef.current = null;
    if (setup) {
      void disposePcmWavRecorderSetup(setup).catch(failure => {
        console.warn('[voice] Pending dictation audio context cleanup failed:', failure);
      });
    }
  }, []);

  const beginHold = () => {
    suppressClickRef.current = false;
    if (disabled || !voice.recognitionAvailable || voice.recording || holdTimerRef.current !== null) return;
    try {
      recorderSetupRef.current = preparePcmWavRecorder();
    } catch {
      recorderSetupRef.current = null;
    }
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdTriggeredRef.current = true;
      suppressClickRef.current = true;
      const setup = recorderSetupRef.current ?? undefined;
      recorderSetupRef.current = null;
      void voice.startRecording(setup);
    }, 240);
  };
  const endHold = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      const setup = recorderSetupRef.current;
      recorderSetupRef.current = null;
      if (setup) {
        void disposePcmWavRecorderSetup(setup).catch(failure => {
          console.warn('[voice] Pending dictation audio context cleanup failed:', failure);
        });
      }
    }
    if (!holdTriggeredRef.current) return;
    holdTriggeredRef.current = false;
    suppressClickRef.current = true;
    voice.stopRecording(onDictation);
  };

  return (
    <button
      className={`send-button${voice.recording ? ' recording' : ''}${className ? ` ${className}` : ''}`}
      type="submit"
      aria-label={voice.recording ? 'Release to transcribe' : voice.recognitionAvailable ? `${label}; hold to dictate` : label}
      aria-pressed={voice.recording}
      title={voice.recording ? 'Release to transcribe' : voice.recognitionAvailable ? `Click to ${label.toLocaleLowerCase()} · hold to dictate` : label}
      disabled={disabled}
      onPointerDown={event => {
        if (event.button === 0) beginHold();
      }}
      onPointerUp={endHold}
      onPointerLeave={endHold}
      onPointerCancel={endHold}
      onKeyDown={event => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) beginHold();
      }}
      onKeyUp={event => {
        if (event.key === ' ' || event.key === 'Enter') endHold();
      }}
      onClick={event => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClickRef.current = false;
        }
      }}
    >{voice.recording ? <Mic size={15} /> : <Send size={15} />}</button>
  );
}
