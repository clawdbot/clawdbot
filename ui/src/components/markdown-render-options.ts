type MarkdownCodeBlockChrome = "copy" | "none";
type MarkdownTableInteractions = "enabled" | "none";
type MarkdownRenderMode = "document" | "message";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  fileLinks?: boolean;
  interactiveImages?: boolean;
  progressBars?: boolean;
  mode?: MarkdownRenderMode;
  sessionLinks?: boolean;
  tableInteractions?: MarkdownTableInteractions;
};

export type MarkdownRenderEnv = Required<MarkdownRenderOptions>;

export function normalizeMarkdownRenderOptions(
  options: MarkdownRenderOptions = {},
): MarkdownRenderEnv {
  return {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders ?? false,
    codeBlockChrome: options.codeBlockChrome ?? "copy",
    fileLinks: options.fileLinks ?? false,
    interactiveImages: options.interactiveImages ?? false,
    progressBars: options.progressBars ?? false,
    mode: options.mode ?? "message",
    sessionLinks: options.sessionLinks ?? false,
    tableInteractions: options.tableInteractions ?? "none",
  };
}
