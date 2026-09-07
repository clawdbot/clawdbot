// Session model projection tests verify ACP metadata reads preserve row ownership.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import * as thinking from "../auto-reply/thinking.js";
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

import {
  resolveGatewayModelThinkingProfile,
  resolveGatewaySessionThinkingProjectionInternal,
} from "./session-utils-model.js";

describe("resolveGatewaySessionThinkingProjectionInternal", () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  beforeEach(() => {
    clearAgentHarnesses();
    readAcpSessionMeta.mockReset();
    readAcpSessionMetaForEntry.mockReset();
  });
  afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

  it.each([
    { api: true, baseUrl: true, levels: ["Off", "High"] },
    { api: false, baseUrl: true, levels: ["Off"] },
    { api: true, baseUrl: false, levels: ["Off"] },
    { api: false, baseUrl: false, levels: ["Off"] },
  ])("uses catalog-only runtime route facts (api=$api, baseUrl=$baseUrl)", (scenario) => {
    const api = "openai-responses" as const;
    const baseUrl = "https://catalog-route.example.test/v1";
    registerAgentHarness({
      id: "catalog-route",
      label: "Catalog route",
      supports: ({ modelProvider }) =>
        modelProvider?.api === api && modelProvider.baseUrl === baseUrl
          ? { supported: true }
          : { supported: false, fallbackRuntime: "openclaw" },
      runAttempt: async () => {
        throw new Error("projection must not execute");
      },
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          thinkingDefault: "off",
          models: { "route-provider/route-model": { agentRuntime: { id: "catalog-route" } } },
        },
      },
    };
    const profile = vi.spyOn(thinking, "resolveThinkingProfile").mockImplementation((params) => ({
      levels: [
        { id: "off", label: "Off", rank: 0 },
        ...(params.agentRuntime === "catalog-route"
          ? [{ id: "high" as const, label: "High", rank: 3 }]
          : []),
      ],
      defaultLevel: "off",
    }));
    const params = {
      cfg,
      agentId: "main",
      provider: "route-provider",
      model: "route-model",
      sessionKey: "agent:main:catalog-route",
      modelCatalog: [
        {
          provider: "route-provider",
          id: "route-model",
          name: "Route model",
          reasoning: true,
          ...(scenario.api ? { api } : {}),
          ...(scenario.baseUrl ? { baseUrl } : {}),
        },
      ],
    };
    try {
      expect(
        resolveGatewayModelThinkingProfile(params).thinkingLevels.map(({ label }) => label),
      ).toEqual(scenario.levels);
      expect(
        resolveGatewaySessionThinkingProjectionInternal({
          ...params,
          entry: { sessionId: "catalog-route", updatedAt: 1 },
        }).thinkingOptions,
      ).toEqual(scenario.levels);
    } finally {
      profile.mockRestore();
    }
  });

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
