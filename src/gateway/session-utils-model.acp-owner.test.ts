// Session model projection tests verify ACP metadata reads preserve row ownership.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { readAcpSessionMeta, readAcpSessionMetaForEntry } = vi.hoisted(() => ({
  readAcpSessionMeta: vi.fn<typeof import("../acp/runtime/session-meta.js").readAcpSessionMeta>(),
  readAcpSessionMetaForEntry:
    vi.fn<typeof import("../acp/runtime/session-meta.js").readAcpSessionMetaForEntry>(),
}));

vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMeta,
  readAcpSessionMetaForEntry,
}));

import { resolveGatewaySessionThinkingProjectionInternal } from "./session-utils-model.js";

describe("resolveGatewaySessionThinkingProjectionInternal", () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  beforeEach(() => {
    clearAgentHarnesses();
    readAcpSessionMeta.mockReset();
    readAcpSessionMetaForEntry.mockReset();
  });
  afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

  it.each([false, true])(
    "projects the effective model runtime with authored transport=%s",
    (transportOverride) => {
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.modelProvider?.requestTransportOverrides === "present"
            ? { supported: false, fallbackRuntime: "openclaw" }
            : { supported: true },
        runAttempt: async () => {
          throw new Error("projection must not execute");
        },
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } } },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "Sol",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 8192,
                  compat: {
                    supportsReasoningEffort: true,
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                    ...(transportOverride ? { supportsStore: false } : {}),
                  },
                },
              ],
            },
          },
        },
      };
      const projection = resolveGatewaySessionThinkingProjectionInternal({
        cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionKey: "agent:main:main",
        entry: {
          sessionId: "runtime-projection",
          updatedAt: 1,
          agentHarnessId: transportOverride ? "codex" : "openclaw",
        },
      });
      expect(projection.agentRuntime).toEqual({
        id: transportOverride ? "openclaw" : "codex",
        source: "model",
      });
    },
  );

  it("reads bare-key ACP metadata under the resolved row owner", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    resolveGatewaySessionThinkingProjectionInternal({
      cfg,
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey: "global",
    });

    expect(readAcpSessionMeta).toHaveBeenCalledWith({ sessionKey: "global", agentId: "ops" });
  });

  it("keeps a prepared row from adopting a replacement session's ACP runtime", () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: { ops: {} },
        defaults: { models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } } },
      },
    };
    const entry = { sessionId: "original", lifecycleRevision: "original-revision", updatedAt: 1 };
    const sessionKey = "agent:ops:acp:owned";
    readAcpSessionMeta.mockReturnValue({
      backend: "replacement-backend",
      agent: "ops",
      runtimeSessionName: "replacement",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 2,
    });

    const projection = resolveGatewaySessionThinkingProjectionInternal({
      cfg,
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey,
      entry,
    });

    expect(projection.agentRuntime.id).toBe("openclaw");
    expect(readAcpSessionMeta).not.toHaveBeenCalled();
    expect(readAcpSessionMetaForEntry).toHaveBeenCalledWith({
      cfg,
      sessionKey,
      agentId: "ops",
      entry,
    });
  });
});
