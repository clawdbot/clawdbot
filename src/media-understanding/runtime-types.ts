import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
// Public media-understanding runtime API types for file-based image/audio/video
// helpers and direct structured extraction.
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
  StructuredExtractionInput,
} from "./types.js";

export type RunMediaUnderstandingFileParams = {
  capability: "image" | "audio" | "video";
  filePath: string;
  mediaUrl?: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
  prompt?: string;
  timeoutMs?: number;
  scopeContext?: MediaUnderstandingScopeContext;
};

type MediaUnderstandingScopeContext = {
  sessionKey?: string;
  channel?: string;
  chatType?: string;
};

export type RunMediaUnderstandingFileResult = {
  text: string | undefined;
  provider?: string;
  model?: string;
  output?: MediaUnderstandingOutput;
  decision?: MediaUnderstandingDecision;
};

export type DescribeImageFileParams = {
  filePath: string;
  mediaUrl?: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
  prompt?: string;
  timeoutMs?: number;
  scopeContext?: MediaUnderstandingScopeContext;
};

export type DescribeImageFileWithModelParams = {
  filePath: string;
  mediaUrl?: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  provider: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
};

export type PreparedImageDescriptionInput = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
};

export type PrepareImageDescriptionInputParams = Pick<
  DescribeImageFileWithModelParams,
  "filePath" | "mediaUrl" | "mime" | "cfg" | "timeoutMs"
>;

export type DescribePreparedImageWithModelParams = Omit<
  DescribeImageFileWithModelParams,
  "filePath" | "mediaUrl" | "mime"
> & {
  image: PreparedImageDescriptionInput;
};

type DescribeImageFileWithModelResult = Awaited<
  ReturnType<NonNullable<MediaUnderstandingProvider["describeImage"]>>
>;

export type ExtractStructuredWithModelParams = {
  /** At least one image input is required; text inputs provide supplemental context. */
  input: StructuredExtractionInput[];
  instructions: string;
  schemaName?: string;
  jsonSchema?: unknown;
  jsonMode?: boolean;
  cfg: OpenClawConfig;
  agentDir?: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
};

type ExtractStructuredWithModelResult = Awaited<
  ReturnType<NonNullable<MediaUnderstandingProvider["extractStructured"]>>
>;

export type DescribeVideoFileParams = {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
};

export type TranscribeAudioFileParams = {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
  language?: string;
  prompt?: string;
};

export type MediaUnderstandingRuntime = {
  runMediaUnderstandingFile: (
    params: RunMediaUnderstandingFileParams,
  ) => Promise<RunMediaUnderstandingFileResult>;
  describeImageFile: (params: DescribeImageFileParams) => Promise<RunMediaUnderstandingFileResult>;
  prepareImageDescriptionInput: (
    params: PrepareImageDescriptionInputParams,
  ) => Promise<PreparedImageDescriptionInput>;
  describePreparedImageWithModel: (
    params: DescribePreparedImageWithModelParams,
  ) => Promise<DescribeImageFileWithModelResult>;
  describeImageFileWithModel: (
    params: DescribeImageFileWithModelParams,
  ) => Promise<DescribeImageFileWithModelResult>;
  extractStructuredWithModel: (
    params: ExtractStructuredWithModelParams,
  ) => Promise<ExtractStructuredWithModelResult>;
  describeVideoFile: (params: DescribeVideoFileParams) => Promise<RunMediaUnderstandingFileResult>;
  transcribeAudioFile: (
    params: TranscribeAudioFileParams,
  ) => Promise<RunMediaUnderstandingFileResult>;
};
