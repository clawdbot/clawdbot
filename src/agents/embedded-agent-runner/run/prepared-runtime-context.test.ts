import { describe, expect, it } from "vitest";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import { bindRunToPreparedModelRuntime } from "./prepared-runtime-context.js";

describe("bindRunToPreparedModelRuntime", () => {
  it("replaces queued config and directories with one committed generation", () => {
    const requestedConfig = { logging: { level: "info" as const } };
    const committedConfig = { logging: { level: "debug" as const } };
    const runParams = {
      runId: "run-1",
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      prompt: "hello",
      config: requestedConfig,
      agentId: "requested-agent",
      agentDir: "/tmp/requested-agent",
      workspaceDir: "/tmp/requested-workspace",
    } as RunEmbeddedAgentParamsWithSessionFile;
    const preparedModelRuntime = {
      agentId: "committed-agent",
      agentDir: "/tmp/committed-agent",
      workspaceDir: "/tmp/committed-workspace",
      config: committedConfig,
    } as PreparedModelRuntimeSnapshot;

    const result = bindRunToPreparedModelRuntime({
      runParams,
      requestedWorkspaceResolution: {
        agentId: "requested-agent",
        agentIdSource: "explicit",
        workspaceDir: "/tmp/requested-workspace",
        usedFallback: true,
        isCanonicalWorkspace: true,
        fallbackReason: "missing",
      },
      preparedModelRuntime,
    });

    expect(result.runParams).toEqual(
      expect.objectContaining({
        agentId: "committed-agent",
        agentDir: "/tmp/committed-agent",
        config: committedConfig,
        workspaceDir: "/tmp/committed-workspace",
      }),
    );
    expect(result.workspaceResolution).toEqual({
      agentId: "committed-agent",
      agentIdSource: "explicit",
      workspaceDir: "/tmp/committed-workspace",
      usedFallback: true,
      isCanonicalWorkspace: true,
      fallbackReason: "missing",
    });
  });
});
