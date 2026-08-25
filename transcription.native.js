import { initWhisper, initWhisperVad } from 'whisper.rn';
import { RealtimeTranscriber } from 'whisper.rn/realtime-transcription/';
import RNFS from 'react-native-fs';
import { LivePcmAdapter } from './realtime-audio';

// PhoWhisper-small is Whisper fine-tuned specifically for Vietnamese speech.
// It replaces the generic 74M-parameter base model used in the first build.
const whisperModel = require('./assets/models/ggml-phowhisper-small.bin');
// Do not send silence and room noise to Whisper.  Small Whisper models are prone
// to producing plausible-looking text for those inputs ("hallucinations").
const vadModel = require('./assets/models/ggml-silero-v6.2.0.bin');
let contextPromise;
let vadContextPromise;

async function getContext() {
  if (!contextPromise) {
    contextPromise = initWhisper({
      filePath: whisperModel,
      useGpu: true,
    });
  }
  return contextPromise;
}

async function getVadContext() {
  if (!vadContextPromise) {
    vadContextPromise = initWhisperVad({
      filePath: vadModel,
      useGpu: true,
      nThreads: 4,
    });
  }
  return vadContextPromise;
}

export async function transcribeLocalAudio(audioPath, onProgress) {
  const context = await getContext();
  const task = context.transcribe(audioPath, {
    language: 'vi',
    maxThreads: 4,
    tokenTimestamps: true,
    // Deterministic beam decoding is slower than greedy decoding, but substantially
    // reduces random word substitutions in the final saved transcript.
    temperature: 0,
    beamSize: 5,
    prompt: 'Đây là bản ghi cuộc họp bằng tiếng Việt. Giữ nguyên tên riêng, thuật ngữ và dấu câu.',
    onProgress,
  });
  return task.promise;
}

// The microphone stream is PCM 16 kHz mono. Whisper receives it while recording,
// then the same bytes are finalized as a local WAV file for replay.
export async function createRealtimeLocalTranscriber({ audioPath, onTranscript, onError }) {
  const [whisperContext, vadContext] = await Promise.all([getContext(), getVadContext()]);
  const audioStream = new LivePcmAdapter();
  return new RealtimeTranscriber(
    { whisperContext, vadContext, audioStream, fs: RNFS },
    {
      audioSliceSec: 45,
      audioMinSec: 1,
      maxSlicesInMemory: 2,
      audioOutputPath: audioPath,
      audioStreamConfig: { sampleRate: 16000, channels: 1, bitsPerSample: 16, bufferSize: 4096 },
      initRealtimeAfterMs: 700,
      realtimeProcessingPauseMs: 1600,
      // VAD's meeting profile only forwards actual speech, preserving a little
      // context around each turn while avoiding noise-induced guesses.
      vadPreset: 'meeting',
      initialPrompt: 'Đây là cuộc họp bằng tiếng Việt.',
      transcribeOptions: { language: 'vi', maxThreads: 4, tokenTimestamps: true, temperature: 0, beamSize: 3 },
    },
    {
      onTranscribe: (event) => {
        if (event.data?.result?.trim()) onTranscript(event);
      },
      onError: (error) => onError?.(String(error)),
    },
  );
}
