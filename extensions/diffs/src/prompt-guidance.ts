export const DIFFS_AGENT_GUIDANCE = [
  "When you need to show edits as a real diff, prefer the `diffs` tool instead of writing a manual summary.",
  "It accepts either `before` + `after` text or a unified `patch`.",
  "`mode=view` returns `details.viewerUrl` for canvas use; `mode=file` returns `details.filePath`; `mode=both` returns both.",
  "If you need to send the rendered file, use the `message` tool with `path` or `filePath`.",
  "Include `path` when you know the filename, and omit presentation overrides unless needed.",
].join("\n");
