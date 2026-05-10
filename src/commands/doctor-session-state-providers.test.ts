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

  it("preserves configured provider CLI runtimes before harness policy normalization", () => {
    const route = resolveConfiguredDoctorSessionStateRoute({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex-cli" },
              models: [],
            },
          },
        },
      },
      sessionKey: "agent:main:telegram:direct:1",
      env: {},
    });
    expect(route.defaultProvider).toBe("openai");
    expect(route.configuredModelRefs).toStrictEqual(["openai/gpt-5.5"]);
    expect(route.runtime).toBe("codex-cli");
  });

  it("ignores legacy environment runtime overrides before plugin-owned scans", () => {
    const route = resolveConfiguredDoctorSessionStateRoute({
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
    });
    expect(route.runtime).toBe("codex");
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

    expect(scan.manualReview).toStrictEqual([]);
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
    expect(entry.sessionId).toBe("sess-stale-codex");
    expect(entry.updatedAt).toBe(123);
    expect(entry.cliSessionBindings).toStrictEqual({
      "claude-cli": { sessionId: "claude-session-1" },
    });
    expect(entry.cliSessionIds).toStrictEqual({
      "claude-cli": "claude-session-1",
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

    expect(scan.repairs).toStrictEqual([]);
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
