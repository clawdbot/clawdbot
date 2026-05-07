import { describe, expect, it } from "vitest";
import {
  applySessionRouteStateRepair,
  resolveConfiguredDoctorSessionStateRoute,
  scanSessionRouteStateOwners,
  storeMayContainPluginSessionRouteState,
} from "./doctor-session-state-providers.js";

const codexOwner = {
  id: "codex",
  label: "Codex",
  providerIds: ["codex", "codex-cli", "openai-codex"],
  runtimeIds: ["codex", "codex-cli"],
  cliSessionKeys: ["codex-cli"],
  authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
};

describe("doctor session state provider routes", () => {
  it("skips plugin route-state scans for unrelated recovery metadata", () => {
    expect(
      storeMayContainPluginSessionRouteState({
        "agent:main:subagent:wedged-child": {
          sessionId: "session-wedged-child",
          updatedAt: 1,
          abortedLastRun: true,
          subagentRecovery: {
            automaticAttempts: 2,
            lastAttemptAt: 1,
            wedgedAt: 2,
            wedgedReason: "blocked",
          },
        },
      }),
    ).toBe(false);

    expect(
      storeMayContainPluginSessionRouteState({
        "agent:main:telegram:direct:1": {
          sessionId: "session-codex",
          updatedAt: 1,
          modelProvider: "openai-codex",
          model: "gpt-5.4",
        },
      }),
    ).toBe(true);
  });

  it("preserves raw configured CLI runtimes before harness policy normalization", () => {
    expect(
      resolveConfiguredDoctorSessionStateRoute({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              agentRuntime: { id: "codex-cli" },
            },
          },
        },
        sessionKey: "agent:main:telegram:direct:1",
        env: {},
      }),
    ).toMatchObject({
      defaultProvider: "openai",
      configuredModelRefs: ["openai/gpt-5.5"],
      runtime: "codex-cli",
    });
  });

  it("keeps implicit OpenAI routes on PI", () => {
    expect(
      resolveConfiguredDoctorSessionStateRoute({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
            },
          },
        },
        sessionKey: "agent:main:telegram:direct:1",
        env: {},
      }),
    ).toMatchObject({
      defaultProvider: "openai",
      configuredModelRefs: ["openai/gpt-5.5"],
      runtime: "pi",
    });
  });

  it("resolves implicit OpenAI Codex routes to the Codex runtime", () => {
    expect(
      resolveConfiguredDoctorSessionStateRoute({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai-codex/gpt-5.5" },
            },
          },
        },
        sessionKey: "agent:main:telegram:direct:1",
        env: {},
      }),
    ).toMatchObject({
      defaultProvider: "openai-codex",
      configuredModelRefs: ["openai-codex/gpt-5.5"],
      runtime: "codex",
    });
  });

  it("keeps implicit custom OpenAI-compatible routes on PI", () => {
    expect(
      resolveConfiguredDoctorSessionStateRoute({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/custom-gpt" },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://compatible.example.test/v1",
                api: "openai-responses",
                models: [],
              },
            },
          },
        },
        sessionKey: "agent:main:telegram:direct:1",
        env: {},
      }),
    ).toMatchObject({
      defaultProvider: "openai",
      configuredModelRefs: ["openai/custom-gpt"],
      runtime: "pi",
    });
  });

  it("lets environment CLI runtime overrides reach plugin-owned scanners", () => {
    expect(
      resolveConfiguredDoctorSessionStateRoute({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              agentRuntime: { id: "pi" },
            },
          },
        },
        sessionKey: "agent:main:telegram:direct:1",
        env: { OPENCLAW_AGENT_RUNTIME: "codex-cli" },
      }),
    ).toMatchObject({
      runtime: "codex-cli",
    });
  });

  it("keeps Codex OAuth route state for canonical OpenAI routes", () => {
    const sessionKey = "agent:main:telegram:direct:1";
    const scan = scanSessionRouteStateOwners({
      owners: [codexOwner],
      store: {
        [sessionKey]: {
          sessionId: "sess-codex-openai",
          updatedAt: 1,
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
          authProfileOverride: "openai-codex:default",
          authProfileOverrideSource: "auto",
          cliSessionBindings: {
            "codex-cli": { sessionId: "codex-session-1" },
          },
        },
      },
      routes: {
        [sessionKey]: {
          defaultProvider: "openai",
          configuredModelRefs: ["openai/gpt-5.5"],
          runtime: "pi",
        },
      },
    });

    expect(scan).toEqual({ repairs: [], manualReview: [] });
  });

  it("clears auto-created route state when current route no longer uses the owner", () => {
    const sessionKey = "agent:main:telegram:direct:1";
    const entry: Record<string, unknown> = {
      sessionId: "sess-stale-codex",
      updatedAt: 1,
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      contextTokens: 1_050_000,
      systemPromptReport: { source: "run" },
      fallbackNoticeSelectedModel: "github-copilot/gpt-5-mini",
      fallbackNoticeActiveModel: "openai-codex/gpt-5.4",
      fallbackNoticeReason: "rate-limit",
      agentHarnessId: "codex",
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 2,
      cliSessionBindings: {
        "codex-cli": { sessionId: "codex-session-1" },
        "claude-cli": { sessionId: "claude-session-1" },
      },
      cliSessionIds: {
        "codex-cli": "codex-session-1",
        "claude-cli": "claude-session-1",
      },
    };

    const scan = scanSessionRouteStateOwners({
      owners: [codexOwner],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "github-copilot",
          configuredModelRefs: ["github-copilot/gpt-5-mini"],
          runtime: "pi",
        },
      },
    });

    expect(scan.manualReview).toEqual([]);
    expect(scan.repairs).toEqual([
      {
        key: sessionKey,
        ownerId: "codex",
        ownerLabel: "Codex",
        cliSessionKeys: ["codex-cli"],
        reasons: [
          "auto model override",
          "runtime model state",
          "pinned runtime",
          "CLI session binding",
          "auto auth profile override",
        ],
      },
    ]);

    expect(applySessionRouteStateRepair({ entry, repair: scan.repairs[0], now: 123 })).toBe(true);
    expect(entry).toMatchObject({
      sessionId: "sess-stale-codex",
      updatedAt: 123,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session-1" },
      },
      cliSessionIds: {
        "claude-cli": "claude-session-1",
      },
    });
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
    expect(entry.modelProvider).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.systemPromptReport).toBeUndefined();
    expect(entry.agentHarnessId).toBeUndefined();
    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
    expect(entry.fallbackNoticeActiveModel).toBeUndefined();
  });

  it("leaves explicit user owner model choices for manual review", () => {
    const sessionKey = "agent:main:telegram:direct:2";
    const entry: Record<string, unknown> = {
      sessionId: "sess-user-codex",
      updatedAt: 1,
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      agentHarnessId: "codex",
      cliSessionBindings: {
        "codex-cli": { sessionId: "codex-session-2" },
      },
    };

    const scan = scanSessionRouteStateOwners({
      owners: [codexOwner],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "github-copilot",
          configuredModelRefs: ["github-copilot/gpt-5-mini"],
          runtime: "pi",
        },
      },
    });

    expect(scan.repairs).toEqual([]);
    expect(scan.manualReview).toEqual([
      {
        key: sessionKey,
        ownerLabel: "Codex",
        message: `${sessionKey} (openai-codex/gpt-5.4, user)`,
      },
    ]);
  });

  it("keeps owner state when owner remains in the configured route", () => {
    const sessionKey = "agent:main:telegram:direct:3";
    const entry: Record<string, unknown> = {
      sessionId: "sess-configured-codex",
      updatedAt: 1,
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      agentHarnessId: "codex",
      cliSessionBindings: {
        "codex-cli": { sessionId: "codex-session-3" },
      },
    };

    const scan = scanSessionRouteStateOwners({
      owners: [codexOwner],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "github-copilot",
          configuredModelRefs: ["github-copilot/gpt-5-mini", "openai-codex/gpt-5.4"],
          runtime: "pi",
        },
      },
    });

    expect(scan).toEqual({ repairs: [], manualReview: [] });
  });

  it("keeps owner CLI state when owner runtime is still configured", () => {
    const sessionKey = "agent:main:telegram:direct:4";
    const entry: Record<string, unknown> = {
      sessionId: "sess-codex-cli",
      updatedAt: 1,
      modelProvider: "codex-cli",
      model: "gpt-5.5",
      cliSessionBindings: {
        "codex-cli": { sessionId: "codex-cli-session" },
      },
    };

    const scan = scanSessionRouteStateOwners({
      owners: [codexOwner],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "openai",
          configuredModelRefs: ["openai/gpt-5.5"],
          runtime: "codex-cli",
        },
      },
    });

    expect(scan).toEqual({ repairs: [], manualReview: [] });
  });
});
