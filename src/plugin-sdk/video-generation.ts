export type GeneratedVideoAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
};

export type VideoGenerationRequestAsset = {
  buffer?: Buffer;
  mimeType?: string;
  url?: string;
};

export type VideoGenerationRequest = {
  cfg?: unknown;
  agentDir?: string;
  authStore?: unknown;
  model?: string;
  prompt?: string;
  inputImages?: VideoGenerationRequestAsset[];
  inputVideos?: VideoGenerationRequestAsset[];
  size?: string;
  durationSeconds?: number;
  request?: unknown;
  [key: string]: unknown;
};

export type VideoGenerationProvider = {
  id: string;
  label: string;
  defaultModel?: string;
  models?: string[];
  isConfigured?: (params: { agentDir?: string }) => boolean;
  capabilities?: Record<string, unknown>;
  generateVideo: (req: VideoGenerationRequest) => Promise<GeneratedVideoAsset | { assets?: GeneratedVideoAsset[] } | unknown>;
};
