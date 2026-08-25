import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import { Buffer } from 'buffer';

// Adapter for whisper.rn's public RealtimeTranscriber interface. Kept in the
// app because the upstream package currently does not export its adapter index.
export class LivePcmAdapter {
  constructor() { this.recording = false; this.config = {}; }

  async initialize(config) {
    this.config = config;
    LiveAudioStream.init({
      sampleRate: config.sampleRate || 16000,
      channels: config.channels || 1,
      bitsPerSample: config.bitsPerSample || 16,
      audioSource: config.audioSource || 6,
      bufferSize: config.bufferSize || 4096,
      wavFile: '',
    });
    LiveAudioStream.on('data', (base64) => {
      const data = new Uint8Array(Buffer.from(base64, 'base64'));
      this.dataCallback?.({ data, sampleRate: this.config.sampleRate || 16000, channels: this.config.channels || 1, timestamp: Date.now() });
    });
  }

  async start() { LiveAudioStream.start(); this.recording = true; this.statusCallback?.(true); }
  async stop() { if (this.recording) await LiveAudioStream.stop(); this.recording = false; this.statusCallback?.(false); }
  isRecording() { return this.recording; }
  onData(callback) { this.dataCallback = callback; }
  onError(callback) { this.errorCallback = callback; }
  onStatusChange(callback) { this.statusCallback = callback; }
  async release() { await this.stop(); this.dataCallback = undefined; }
}
