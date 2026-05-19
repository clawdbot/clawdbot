import type { OutboundAudioPort } from "../adapter/audio.port.js";

let outboundAudioPort: OutboundAudioPort | null = null;

/**
 * Initialize the outbound audio adapter. Called once by gateway startup
 * via `adapters.outboundAudio`.
 */
export function setOutboundAudioPort(port: OutboundAudioPort): void {
  outboundAudioPort = port;
}

function getAudio(): OutboundAudioPort {
  if (!outboundAudioPort) {
    throw new Error("OutboundAudioPort not initialized — call setOutboundAudioPort first");
  }
  return outboundAudioPort;
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
