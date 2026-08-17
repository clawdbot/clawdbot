type MarkdownCodeBlockChrome = "copy" | "none";
type MarkdownRenderMode = "document" | "message";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  fileLinks?: boolean;
  interactiveImages?: boolean;
  progressBars?: boolean;
  mode?: MarkdownRenderMode;
  sessionLinks?: boolean;
  documentId?: string;
};

export type MarkdownRenderEnv = Required<Omit<MarkdownRenderOptions, "documentId">> & {
  docId?: string;
};

function markdownDocumentId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

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
    docId: markdownDocumentId(options.documentId),
  };
}
