import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import "./claude-live-session.js";
import type { PreparedCliRunContext } from "./types.js";

type BuildClaudeLiveArgsParams = {
  args: string[];
  backend: CliBackendConfig;
  systemPrompt: string;
  useResume: boolean;
  permissionMode?: string;
};

type ClaudeLiveSessionTestApi = {
  buildClaudeLiveArgs(params: BuildClaudeLiveArgsParams): string[];
  readConfiguredExecPolicy(context: PreparedCliRunContext): {
    security: string;
    ask: string;
    agentId: string;
  };
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

export function readConfiguredExecPolicy(context: PreparedCliRunContext) {
  return getTestApi().readConfiguredExecPolicy(context);
}

export function resetClaudeLiveSessionsForTest(): void {
  getTestApi().resetClaudeLiveSessionsForTest();
}
