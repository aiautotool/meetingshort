import { initWhisper } from 'whisper.rn';
import { RealtimeTranscriber } from 'whisper.rn/realtime-transcription/';
import RNFS from 'react-native-fs';
import { LivePcmAdapter } from './realtime-audio';

const whisperModel = require('./assets/models/ggml-base.bin');
let contextPromise;

async function getContext() {
  if (!contextPromise) {
    contextPromise = initWhisper({
      filePath: whisperModel,
      useGpu: true,
    });
  }
  return contextPromise;
}

export async function transcribeLocalAudio(audioPath, onProgress) {
  const context = await getContext();
  const task = context.transcribe(audioPath, {
    language: 'vi',
    maxThreads: 4,
    tokenTimestamps: true,
    onProgress,
  });
  return task.promise;
}

// The microphone stream is PCM 16 kHz mono. Whisper receives it while recording,
// then the same bytes are finalized as a local WAV file for replay.
export async function createRealtimeLocalTranscriber({ audioPath, onTranscript, onError }) {
  const whisperContext = await getContext();
  const audioStream = new LivePcmAdapter();
  return new RealtimeTranscriber(
    { whisperContext, audioStream, fs: RNFS },
    {
      audioSliceSec: 20,
      audioMinSec: 1,
      maxSlicesInMemory: 2,
      audioOutputPath: audioPath,
      audioStreamConfig: { sampleRate: 16000, channels: 1, bitsPerSample: 16, bufferSize: 4096 },
      initRealtimeAfterMs: 700,
      realtimeProcessingPauseMs: 1600,
      transcribeOptions: { language: 'vi', maxThreads: 4, tokenTimestamps: true },
    },
    {
      onTranscribe: (event) => {
        if (event.data?.result?.trim()) onTranscript(event);
      },
      onError: (error) => onError?.(String(error)),
    },
  );
}
