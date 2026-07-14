export const CLAUDE_CLI_CONTEXT_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  "opus-4.8": "claude-opus-4-8",
  "opus-4-8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4-7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "opus-4-6": "claude-opus-4-6",
  sonnet: "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4-6": "claude-sonnet-4-6",
};

export function resolveNodeClaudePlacement(params: {
  backendId: string;
  execHost?: string;
  execNode?: string;
}): boolean {
  if (params.backendId === "claude-cli" && params.execHost === "node" && !params.execNode?.trim()) {
    throw new Error("node-placed Claude CLI session is missing execNode");
  }
  return (
    params.backendId === "claude-cli" &&
    params.execHost === "node" &&
    Boolean(params.execNode?.trim())
  );
}
