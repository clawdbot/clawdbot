import type { CliBackendConfig } from "../../config/types.js";
import "./claude-live-session.js";

type BuildClaudeLiveArgsParams = {
  args: string[];
  backend: CliBackendConfig;
  systemPrompt: string;
  useResume: boolean;
  permissionMode?: string;
};

type ClaudeLiveSessionTestApi = {
  buildClaudeLiveArgs(params: BuildClaudeLiveArgsParams): string[];
  resetClaudeLiveSessionsForTest(): void;
};

function getTestApi(): ClaudeLiveSessionTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.claudeLiveSessionTestApi")
  ] as ClaudeLiveSessionTestApi;
}

export function buildClaudeLiveArgs(params: BuildClaudeLiveArgsParams): string[] {
  return getTestApi().buildClaudeLiveArgs(params);
}

export function resetClaudeLiveSessionsForTest(): void {
  getTestApi().resetClaudeLiveSessionsForTest();
}
