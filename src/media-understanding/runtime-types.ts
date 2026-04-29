import type { OpenClawConfig } from "../config/types.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import type { MediaUnderstandingOutput, MediaUnderstandingProvider } from "./types.js";

export type RunMediaUnderstandingFileParams = {
  capability: "image" | "audio" | "video";
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
  prompt?: string;
  timeoutMs?: number;
};

export type RunMediaUnderstandingFileResult = {
  text: string | undefined;
  provider?: string;
  model?: string;
  output?: MediaUnderstandingOutput;
};

export type DescribeImageFileParams = {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
  prompt?: string;
  timeoutMs?: number;
};

export type DescribeImageFileWithModelParams = {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  provider: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
};

export type DescribeImageFileWithModelResult = Awaited<
  ReturnType<NonNullable<MediaUnderstandingProvider["describeImage"]>>
>;

export type DescribeVideoFileParams = {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
};

export type TranscribeAudioFileParams = {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
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
  describeImageFileWithModel: (
    params: DescribeImageFileWithModelParams,
  ) => Promise<DescribeImageFileWithModelResult>;
  describeVideoFile: (params: DescribeVideoFileParams) => Promise<RunMediaUnderstandingFileResult>;
  transcribeAudioFile: (params: TranscribeAudioFileParams) => Promise<{ text: string | undefined }>;
};
