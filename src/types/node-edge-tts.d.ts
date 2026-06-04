/** Minimal ambient types for node-edge-tts voice synthesis. */
declare module "node-edge-tts" {
  /** Options passed to the Edge TTS wrapper. */
  export type EdgeTTSOptions = {
    voice?: string;
    lang?: string;
    outputFormat?: string;
    saveSubtitles?: boolean;
    proxy?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
    timeout?: number;
  };

  /** Edge TTS class subset used by OpenClaw audio generation. */
  export class EdgeTTS {
    constructor(options?: EdgeTTSOptions);
    ttsPromise(text: string, outputPath: string): Promise<void>;
  }
}

declare module "node-edge-tts/dist/drm.js" {
  /** Chromium version constant required by the upstream token generator. */
  export const CHROMIUM_FULL_VERSION: string;
  /** Trusted client token required by the upstream token generator. */
  export const TRUSTED_CLIENT_TOKEN: string;
  /** Generate the DRM token needed by Edge TTS requests. */
  export function generateSecMsGecToken(): string;
}
