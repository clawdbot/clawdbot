import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionCompanion } from "./session-companion.js";

const runEmbeddedAgent = vi.hoisted(() =>
  vi.fn<
    (params: RunEmbeddedAgentParams) => Promise<{
      meta: { durationMs: number; finalAssistantVisibleText: string };
    }>
  >(),
);

vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
vi.mock("../agents/internal-session-effects.js", () => ({
  prepareInternalSessionEffectsSession: async () => ({
    sessionId: "companion-run",
    sessionKey: "agent:main:internal:companion-run",
  }),
  removeInternalSessionEffectsSession: async () => {},
}));
vi.mock("../agents/sessions/index.js", () => ({
  SessionManager: { open: () => ({ appendMessage: () => {} }) },
}));
vi.mock("../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent: () => ({ provider: "test", modelId: "model-a" }),
}));

describe("session companion embedded invocation", () => {
  it("keeps read-only tools direct when the selected agent model opts into Code Mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/companion-test",
          models: { "test/model-a": { codeMode: true } },
        },
        entries: {
          main: {
            models: { "test/model-a": { codeMode: true } },
            tools: { codeMode: true },
          },
        },
      },
      tools: { toolSearch: true, codeMode: { enabled: true, maxOutputBytes: 4096 } },
    };
    runEmbeddedAgent.mockResolvedValueOnce({
      meta: { durationMs: 1, finalAssistantVisibleText: "The session is reading a file." },
    });
    const companion = createSessionCompanion({
      getConfig: () => cfg,
      contextReader: {
        currentSessionId: () => "session-1",
        read: async () => ({
          kind: "ready",
          context: { empty: true, messages: [], sessionId: "session-1" },
        }),
      },
      sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
      resolveUtilityModelRef: () => "test/model-a",
    });

    try {
      await expect(
        companion.ask({
          agentId: "main",
          sessionKey: "agent:main:main",
          question: "What is it doing?",
          connId: "conn-1",
        }),
      ).resolves.toMatchObject({ answer: "The session is reading a file." });
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      const invocation = runEmbeddedAgent.mock.calls[0]?.[0];
      if (!invocation) {
        throw new Error("Expected the companion embedded invocation");
      }
      expect(invocation.config?.tools?.codeMode).toEqual(cfg.tools?.codeMode);
      const surface = createAgentHarnessToolSurfaceRuntimeCore({
        config: invocation.config,
        agentId: invocation.agentId,
        modelProvider: invocation.provider,
        modelId: invocation.model,
        model: { compat: { codeMode: "preferred" } },
        codeModeOverride: invocation.codeModeOverride,
        toolsAllow: invocation.toolsAllow,
        modelToolsEnabled: true,
        executeTool: async () => ({ content: [], details: {} }),
      });
      try {
        const tools = ["read", "sessions_history", "sessions_search"].map(createStubTool);
        expect(surface.compactTools(tools).tools.map((tool) => tool.name)).toEqual([
          "read",
          "sessions_history",
          "sessions_search",
        ]);
      } finally {
        surface.cleanup();
      }
    } finally {
      companion.dispose();
    }
  });
});
