import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  SessionMcpRuntime,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import "./native-mcp-app.js";

type NativeMcpAppTestApi = {
  createNativeMcpRuntime: (params: {
    client: CodexAppServerClient;
    threadId: string;
    attempt: EmbeddedRunAttemptParams;
  }) => SessionMcpRuntime;
};

const api = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.codexNativeMcpAppTestApi")
] as NativeMcpAppTestApi | undefined;

if (!api) {
  throw new Error("Codex native MCP App test API is unavailable");
}

export const testing = api;
