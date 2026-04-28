import type { OutboundAudioPort } from "../adapter/audio.port.js";

let _audioPort: OutboundAudioPort | null = null;

/**
 * Initialize the outbound audio adapter. Called once by gateway startup
 * via `adapters.outboundAudio`.
 */
export function setOutboundAudioPort(port: OutboundAudioPort): void {
  _audioPort = port;
}

function getAudio(): OutboundAudioPort {
  if (!_audioPort) {
    throw new Error("OutboundAudioPort not initialized — call setOutboundAudioPort first");
  }
  return _audioPort;
}

export function audioFileToSilkBase64(p: string, f?: string[]): Promise<string | undefined> {
  return getAudio().audioFileToSilkBase64(p, f);
}

export function isAudioFile(p: string, m?: string): boolean {
  try {
    return getAudio().isAudioFile(p, m);
  } catch {
    return false;
  }
}

export function shouldTranscodeVoice(p: string): boolean {
  return getAudio().shouldTranscodeVoice(p);
}

export function waitForFile(p: string, ms?: number): Promise<number> {
  return getAudio().waitForFile(p, ms);
}
