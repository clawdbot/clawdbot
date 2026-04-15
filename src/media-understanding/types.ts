import type { OpenClawConfig } from "../config/types.openclaw.js";

export type MediaUnderstandingKind =
  | "audio.transcription"
  | "video.description"
  | "image.description";

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export type MediaUnderstandingCapabilityRegistry = Map<
  string,
  {
    capabilities?: MediaUnderstandingCapability[];
  }
>;

export type MediaAttachment = {
  path?: string;
  url?: string;
  mime?: string;
  index: number;
  alreadyTranscribed?: boolean;
};

export type MediaUnderstandingOutput = {
  kind: MediaUnderstandingKind;
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
};

export type MediaUnderstandingDecisionOutcome =
  | "success"
  | "failed"
  | "skipped"
  | "disabled"
  | "no-attachment"
  | "scope-deny";

export type MediaUnderstandingModelDecision = {
  provider?: string;
  model?: string;
  type: "provider" | "cli";
  outcome: "success" | "skipped" | "failed";
  reason?: string;
};

export type MediaUnderstandingAttemptOutcome = MediaUnderstandingModelDecision["outcome"];

export type MediaUnderstandingAttachmentDecision = {
  attachmentIndex: number;
  attempts: MediaUnderstandingModelDecision[];
  chosen?: MediaUnderstandingModelDecision;
};

export type MediaUnderstandingDecision = {
  capability: MediaUnderstandingCapability;
  outcome: MediaUnderstandingDecisionOutcome;
  attachments: MediaUnderstandingAttachmentDecision[];
};

export type MediaUnderstandingProviderRequestAuthOverride =
  | { mode: "provider-default" }
  | { mode: "authorization-bearer"; token: string }
  | { mode: "header"; headerName: string; value: string; prefix?: string };

export type MediaUnderstandingProviderRequestTlsOverride = {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
};

export type MediaUnderstandingProviderRequestProxyOverride =
  | { mode: "env-proxy"; tls?: MediaUnderstandingProviderRequestTlsOverride }
  | { mode: "explicit-proxy"; url: string; tls?: MediaUnderstandingProviderRequestTlsOverride };

export type MediaUnderstandingProviderRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: MediaUnderstandingProviderRequestAuthOverride;
  proxy?: MediaUnderstandingProviderRequestProxyOverride;
  tls?: MediaUnderstandingProviderRequestTlsOverride;
  /** Runtime-only flag from trusted model-provider config; media config rejects it. */
  allowPrivateNetwork?: boolean;
};

export type AudioTranscriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  model?: string;
  language?: string;
  prompt?: string;
  query?: Record<string, string | number | boolean>;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};

export type AudioTranscriptionResult = {
  text: string;
  model?: string;
};

export type VideoDescriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};

export type VideoDescriptionResult = {
  text: string;
  model?: string;
};

export type ImageDescriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  agentDir: string;
  cfg: OpenClawConfig;
  model: string;
  provider: string;
};

export type ImagesDescriptionInput = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
};

export type ImagesDescriptionRequest = {
  images: ImagesDescriptionInput[];
  model: string;
  provider: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  agentDir: string;
  cfg: OpenClawConfig;
};

export type ImageDescriptionResult = {
  text: string;
  model?: string;
};

export type ImagesDescriptionResult = {
  text: string;
  model?: string;
};

export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
  describeImages?: (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
};
