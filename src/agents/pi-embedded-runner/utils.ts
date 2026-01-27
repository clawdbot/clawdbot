import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { ExecToolDefaults } from "../bash-tools.js";

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh"; Moltbot enables it for specific models.
  if (!level) return "off";
  return level;
}

export function resolveExecToolDefaults(config?: MoltbotConfig): ExecToolDefaults | undefined {
  const tools = config?.tools;
  if (!tools?.exec) return undefined;
  return tools.exec;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
