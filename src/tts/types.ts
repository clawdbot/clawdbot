export interface TTSRequest {
  text: string;
  model?: string;
  voiceId?: string;
  emotion?: string;
  speed?: number;
}

export interface TTSResponse {
  success: boolean;
  audioPath?: string;
  error?: string;
  cached?: boolean;
}

export type TTSProgressCallback = (progress: number) => void | Promise<void>;
