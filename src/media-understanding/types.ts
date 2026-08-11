// Shared media-understanding types for attachments, provider hooks, request
// auth, decisions, and structured extraction inputs.
import type { MediaUnderstandingCapability } from "../../packages/media-understanding-common/src/types.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Agent-owned runtime handle carried opaquely through media provider requests. */
type MediaPreparedModelRuntime = Readonly<{
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  createStores: () => unknown;
}>;

export type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingCapabilityRegistry,
  MediaUnderstandingOutput,
} from "../../packages/media-understanding-common/src/types.js";

type MediaUnderstandingDecisionOutcome =
  | "success"
  | "failed"
  | "skipped"
  | "disabled"
  | "no-attachment"
  | "scope-deny";

export type MediaUnderstandingModelDecision = {
  provider?: string;
  model?: string;
  requestedBackend?: string;
  observedBackend?: string;
  type: "provider" | "cli";
  outcome: "success" | "skipped" | "failed";
  reason?: string;
};

type MediaUnderstandingAttachmentDecision = {
  attachmentIndex: number;
  attempts: MediaUnderstandingModelDecision[];
  chosen?: MediaUnderstandingModelDecision;
};

export type MediaAttachmentDisposition =
  | { kind: "handled" }
  | { kind: "handed-to-native-vision" }
  | { kind: "not-selected" }
  | { kind: "capability-disabled" }
  | { kind: "no-model" }
  | { kind: "scope-denied" }
  | { kind: "failed"; reason?: string };

export type MediaUnderstandingDecision = {
  capability: MediaUnderstandingCapability;
  outcome: MediaUnderstandingDecisionOutcome;
  attachments: MediaUnderstandingAttachmentDecision[];
  // Optional on the shipped SDK contract: plugins pass FinalizedMsgContext into
  // inbound-reply dispatch and may hold legacy decision literals. Core producers
  // (runner, apply-capability, runtime) always populate it; absence renders no
  // markers rather than breaking plugin compilation.
  attachmentDispositions?: Record<number, MediaAttachmentDisposition>;
  nativeVisionActive?: boolean;
};

type MediaUnderstandingProviderRequestAuthOverride =
  | { mode: "provider-default" }
  | { mode: "authorization-bearer"; token: string }
  | { mode: "header"; headerName: string; value: string; prefix?: string };

type MediaUnderstandingProviderRequestTlsOverride = {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
};

type MediaUnderstandingProviderRequestProxyOverride =
  | { mode: "env-proxy"; tls?: MediaUnderstandingProviderRequestTlsOverride }
  | { mode: "explicit-proxy"; url: string; tls?: MediaUnderstandingProviderRequestTlsOverride };

type MediaUnderstandingProviderRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: MediaUnderstandingProviderRequestAuthOverride;
  proxy?: MediaUnderstandingProviderRequestProxyOverride;
  tls?: MediaUnderstandingProviderRequestTlsOverride;
  /** Runtime-only flag from trusted model-provider config; media config rejects it. */
  allowPrivateNetwork?: boolean;
};

export type MediaUnderstandingProviderRequestAuth =
  | { kind: "api-key"; apiKey: string; source?: string }
  | { kind: "none"; source: string };

export type AudioTranscriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  /** Compatibility field for existing providers; prefer auth.kind/apiKey. */
  apiKey: string;
  auth?: MediaUnderstandingProviderRequestAuth;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  model?: string;
  language?: string;
  prompt?: string;
  query?: Record<string, string | number | boolean>;
  timeoutMs: number;
  signal?: AbortSignal;
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
  /** Compatibility field for existing providers; prefer auth.kind/apiKey. */
  apiKey: string;
  auth?: MediaUnderstandingProviderRequestAuth;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  signal?: AbortSignal;
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
  signal?: AbortSignal;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  preparedModelRuntime?: MediaPreparedModelRuntime;
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
  signal?: AbortSignal;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  preparedModelRuntime?: MediaPreparedModelRuntime;
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

export type StructuredExtractionTextInput = {
  type: "text";
  text: string;
};

export type StructuredExtractionImageInput = {
  type: "image";
  buffer: Buffer;
  fileName: string;
  mime?: string;
};

export type StructuredExtractionInput =
  | StructuredExtractionTextInput
  | StructuredExtractionImageInput;

export type StructuredExtractionRequest = {
  /** Image-first extraction input; callers must include at least one image. */
  input: StructuredExtractionInput[];
  instructions: string;
  schemaName?: string;
  jsonSchema?: unknown;
  jsonMode?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentDir: string;
  cfg: OpenClawConfig;
  model: string;
  provider: string;
};

export type StructuredExtractionResult = {
  text: string;
  parsed?: unknown;
  model?: string;
  provider?: string;
  contentType?: "json" | "text";
};

type MediaUnderstandingDocumentModelDefaults = {
  textExtraction?: string;
  image?: string | false;
};

export type MediaUnderstandingProviderAuthContext = {
  config?: OpenClawConfig;
  provider: string;
  providerConfig?: ModelProviderConfig;
};

export type MediaUnderstandingProviderAuthResult =
  | { kind: "none"; source: string }
  | { kind: "api-key"; apiKey: string; source: string; mode?: "api-key" };

export type MediaUnderstandingProviderSyntheticAuthResult = {
  apiKey: string;
  source: string;
  mode: "api-key";
};

export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
  documentModels?: Partial<Record<"pdf", MediaUnderstandingDocumentModelDefaults>>;
  resolveAuth?: (
    ctx: MediaUnderstandingProviderAuthContext,
  ) => MediaUnderstandingProviderAuthResult | null | undefined;
  /** @deprecated Use resolveAuth. */
  resolveSyntheticAuth?: (
    ctx: MediaUnderstandingProviderAuthContext,
  ) => MediaUnderstandingProviderSyntheticAuthResult | null | undefined;
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
  describeImages?: (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
  extractStructured?: (req: StructuredExtractionRequest) => Promise<StructuredExtractionResult>;
};
