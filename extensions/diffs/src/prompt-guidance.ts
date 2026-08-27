// Diffs plugin module implements prompt guidance behavior.
export const DIFFS_AGENT_GUIDANCE = [
  "When you need to show edits as a real diff, prefer the `diffs` tool instead of writing a manual summary.",
  "It accepts either `before` + `after` text or a unified `patch`.",
  "Check `details.changed`: identical before/after input returns `false` without creating an artifact; rendered results return `true`.",
  "`mode=view` returns `details.viewerUrl` for interactive viewing; `mode=file` returns `details.filePath`; `mode=both` returns both.",
  "To send the rendered file, use an available file-sending tool to send `details.filePath` as an attachment.",
  "Include `path` when you know the filename, and omit presentation overrides unless needed.",
].join("\n");
