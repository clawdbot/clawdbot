/**
 * Claude CLI argument helpers for OpenClaw-managed bundle MCP config.
 */
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withOpenClawMcpCaptureHeader } from "./bundle-mcp-runtime.js";

/** Find existing Claude `--mcp-config` argument values. */
export function findClaudeMcpConfigPaths(args?: string[]): string[] {
  const paths: string[] = [];
  if (!args?.length) {
    return paths;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      // Claude treats --mcp-config as variadic. Keep this scan aligned with
      // extensions/anthropic/cli-shared.ts so user config files are not leaked
      // as positional prompts after OpenClaw injects its strict overlay.
      while (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
        i += 1;
        const path = normalizeOptionalString(args[i]);
        if (path) {
          paths.push(path);
        }
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      const path = normalizeOptionalString(arg.slice("--mcp-config=".length));
      if (path) {
        paths.push(path);
      }
    }
  }
  return paths;
}

/** Return Claude args with OpenClaw's strict MCP config path injected. */
function mergeClaudeDisallowedTools(args: string[], deniedTools: string[]): string[] {
  if (deniedTools.length === 0) {
    return args;
  }
  const next: string[] = [];
  const existingDisallowed: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--disallowedTools" || arg === "--disallowed-tools") {
      while (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
        i += 1;
        existingDisallowed.push(args[i] ?? "");
      }
      continue;
    }
    if (arg.startsWith("--disallowedTools=") || arg.startsWith("--disallowed-tools=")) {
      existingDisallowed.push(arg.slice(arg.indexOf("=") + 1));
      continue;
    }
    next.push(arg);
  }
  next.push("--disallowedTools", [...new Set([...existingDisallowed, ...deniedTools])].join(","));
  return next;
}

export function injectClaudeWebSearchDisabledArgs(args: string[] | undefined): string[] {
  return mergeClaudeDisallowedTools(args ?? [], ["WebSearch"]);
}

export function injectClaudeMcpConfigArgs(
  args: string[] | undefined,
  mcpConfigPath: string,
  mcpToolsDeny?: Record<string, string[]>,
  webSearchEnabled?: boolean,
): string[] {
  const next: string[] = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    const arg = args?.[i] ?? "";
    if (arg === "--strict-mcp-config") {
      continue;
    }
    if (arg === "--mcp-config") {
      while (typeof args?.[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      continue;
    }
    next.push(arg);
  }
  next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  const deniedTools = Object.entries(mcpToolsDeny ?? {}).flatMap(([serverName, toolNames]) =>
    toolNames.map((toolName) => `mcp__${serverName}__${toolName}`),
  );
  if (webSearchEnabled === false) {
    deniedTools.push("WebSearch");
  }
  return mergeClaudeDisallowedTools(next, deniedTools.toSorted());
}

/** Writes the active per-attempt capture token into OpenClaw's generated Claude MCP config. */
export async function writeClaudeMcpCaptureConfig(params: {
  mcpConfigPath: string;
  captureKey: string;
}): Promise<void> {
  const raw = JSON.parse(await fs.readFile(params.mcpConfigPath, "utf-8")) as unknown;
  if (!isRecord(raw)) {
    throw new Error("Claude MCP capture requires an object config");
  }
  await fs.writeFile(
    params.mcpConfigPath,
    `${JSON.stringify(
      withOpenClawMcpCaptureHeader(
        raw,
        params.captureKey,
        "Claude MCP capture requires an openclaw server config",
      ),
      null,
      2,
    )}\n`,
    "utf-8",
  );
}
