export async function transcribeLocalAudio() {
  throw new Error('Whisper on-device is available in the installed iOS/Android app, not in the web preview.');
}

export async function createRealtimeLocalTranscriber() {
  throw new Error('Realtime transcript on-device is available in the installed iOS/Android app, not in the web preview.');
}
