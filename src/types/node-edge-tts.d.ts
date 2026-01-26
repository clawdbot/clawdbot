declare module "node-edge-tts" {
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

  export class EdgeTTS {
    constructor(options?: EdgeTTSOptions);
    ttsPromise(text: string, outputPath: string): Promise<void>;
  }
}
