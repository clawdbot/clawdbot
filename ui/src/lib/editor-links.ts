// Desktop editors reachable from the browser UI via custom URL schemes; a
// window.open on these hands off to the OS without navigating the page.
export const EDITOR_IDS = ["cursor", "vscode", "windsurf", "zed"] as const;
export type EditorId = (typeof EDITOR_IDS)[number];

// Product names, not translatable copy.
export const EDITOR_LABELS: Record<EditorId, string> = {
  cursor: "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
  zed: "Zed",
};

function editorOpenUrl(editor: EditorId, absPath: string, line?: number | null): string {
  const normalizedPath = absPath.replaceAll("\\", "/");
  const urlPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const encodedPath = urlPath
    .split("/")
    .map((segment, index) =>
      index === 1 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
  return `${editor}://file${encodedPath}${line ? `:${line}` : ""}`;
}

export function openEditor(editor: EditorId, path: string, line?: number | null) {
  // Typed editor IDs plus encoded paths make this custom-scheme handoff safe.
  return window.open(editorOpenUrl(editor, path, line));
}
