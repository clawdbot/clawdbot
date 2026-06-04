import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

// Claude CLI MCP argument helpers. OpenClaw owns the generated config path, so
// existing mcp-config flags are stripped before injecting strict config args.
/** Find an existing Claude `--mcp-config` argument value. */
export function findClaudeMcpConfigPath(args?: string[]): string | undefined {
  if (!args?.length) {
    return undefined;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      return normalizeOptionalString(args[i + 1]);
    }
    if (arg.startsWith("--mcp-config=")) {
      return normalizeOptionalString(arg.slice("--mcp-config=".length));
    }
  }
  return undefined;
}

/** Return Claude args with OpenClaw's strict MCP config path injected. */
export function injectClaudeMcpConfigArgs(
  args: string[] | undefined,
  mcpConfigPath: string,
): string[] {
  const next: string[] = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    const arg = args?.[i] ?? "";
    if (arg === "--strict-mcp-config") {
      continue;
    }
    if (arg === "--mcp-config") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      continue;
    }
    next.push(arg);
  }
  next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  return next;
}
