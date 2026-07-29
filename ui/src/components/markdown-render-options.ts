type MarkdownCodeBlockChrome = "copy" | "none";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  fileLinks?: boolean;
  interactiveImages?: boolean;
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
  };
}
