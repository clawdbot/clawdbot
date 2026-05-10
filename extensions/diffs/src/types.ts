import type { FileContents, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";

export const DIFF_LAYOUTS = ["unified", "split"] as const;
export const DIFF_MODES = ["view", "image", "file", "both"] as const;
export const DIFF_THEMES = ["light", "dark"] as const;
export const DIFF_INDICATORS = ["bars", "classic", "none"] as const;
export const DIFF_IMAGE_QUALITY_PRESETS = ["standard", "hq", "print"] as const;
export const DIFF_OUTPUT_FORMATS = ["png", "pdf"] as const;

export type DiffLayout = (typeof DIFF_LAYOUTS)[number];
export type DiffMode = (typeof DIFF_MODES)[number];
export type DiffTheme = (typeof DIFF_THEMES)[number];
export type DiffIndicators = (typeof DIFF_INDICATORS)[number];
export type DiffImageQualityPreset = (typeof DIFF_IMAGE_QUALITY_PRESETS)[number];
export type DiffOutputFormat = (typeof DIFF_OUTPUT_FORMATS)[number];
export type DiffRenderTarget = "viewer" | "image" | "both";

type DiffPresentationDefaults = {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  layout: DiffLayout;
  showLineNumbers: boolean;
  diffIndicators: DiffIndicators;
  wordWrap: boolean;
  background: boolean;
  theme: DiffTheme;
};

export type DiffFileDefaults = {
  fileFormat: DiffOutputFormat;
  fileQuality: DiffImageQualityPreset;
  fileScale: number;
  fileMaxWidth: number;
};

export type DiffToolDefaults = DiffPresentationDefaults &
  DiffFileDefaults & {
    mode: DiffMode;
    ttlSeconds: number;
  };

type BeforeAfterDiffInput = {
  kind: "before_after";
  before: string;
  after: string;
  path?: string;
  lang?: string;
  title?: string;
};

type PatchDiffInput = {
  kind: "patch";
  patch: string;
  title?: string;
};

export type DiffInput = BeforeAfterDiffInput | PatchDiffInput;

export type DiffRenderOptions = {
  presentation: DiffPresentationDefaults;
  image: {
    format: DiffOutputFormat;
    qualityPreset: DiffImageQualityPreset;
    scale: number;
    maxWidth: number;
    maxPixels: number;
  };
  expandUnchanged: boolean;
};

export type DiffViewerOptions = {
  theme: {
    light: "pierre-light";
    dark: "pierre-dark";
  };
  diffStyle: DiffLayout;
  diffIndicators: DiffIndicators;
  disableLineNumbers: boolean;
  expandUnchanged: boolean;
  themeType: DiffTheme;
  backgroundEnabled: boolean;
  overflow: "scroll" | "wrap";
  unsafeCSS: string;
};

export type DiffViewerPayload = {
  prerenderedHTML: string;
  options: DiffViewerOptions;
  langs: SupportedLanguages[];
  oldFile?: FileContents;
  newFile?: FileContents;
  fileDiff?: FileDiffMetadata;
};

export type RenderedDiffDocument = {
  html?: string;
  imageHtml?: string;
  title: string;
  fileCount: number;
  inputKind: DiffInput["kind"];
};

export type DiffArtifactContext = {
  agentId?: string;
  sessionId?: string;
  messageChannel?: string;
  agentAccountId?: string;
};

export type DiffArtifactMeta = {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  title: string;
  inputKind: DiffInput["kind"];
  fileCount: number;
  viewerPath: string;
  htmlPath: string;
  context?: DiffArtifactContext;
  filePath?: string;
  imagePath?: string;
};

export const DIFF_ARTIFACT_ID_PATTERN = /^[0-9a-f]{20}$/;
export const DIFF_ARTIFACT_TOKEN_PATTERN = /^[0-9a-f]{48}$/;
