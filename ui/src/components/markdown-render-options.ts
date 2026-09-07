type MarkdownCodeBlockChrome = "copy" | "none";
type MarkdownCodeBlockInteraction = "interactive" | "static";
type MarkdownTableInteractions = "enabled" | "none";
type MarkdownRenderMode = "document" | "message";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  codeBlockInteraction?: MarkdownCodeBlockInteraction;
  fileLinks?: boolean;
  interactiveImages?: boolean;
  linkFavicons?: boolean;
  progressBars?: boolean;
  mode?: MarkdownRenderMode;
  remoteImages?: boolean;
  sessionLinks?: boolean;
  tableInteractions?: MarkdownTableInteractions;
};

export type MarkdownRenderEnv = Required<MarkdownRenderOptions> & {
  streamingOpenFence?: boolean;
};

export function normalizeMarkdownRenderOptions(
  options: MarkdownRenderOptions = {},
): MarkdownRenderEnv {
  return {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders ?? false,
    codeBlockChrome: options.codeBlockChrome ?? "copy",
    codeBlockInteraction: options.codeBlockInteraction ?? "static",
    fileLinks: options.fileLinks ?? false,
    interactiveImages: options.interactiveImages ?? false,
    linkFavicons: options.linkFavicons ?? false,
    progressBars: options.progressBars ?? false,
    mode: options.mode ?? "message",
    remoteImages: options.remoteImages ?? options.mode === "document",
    sessionLinks: options.sessionLinks ?? false,
    tableInteractions: options.tableInteractions ?? "none",
  };
}
