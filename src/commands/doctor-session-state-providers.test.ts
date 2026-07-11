// Doctor session state provider tests cover route-state repair and configured provider resolution.
import { describe, expect, it, vi } from "vitest";
import {
  applySessionRouteStateRepair,
  resolveConfiguredDoctorSessionStateRoute,
  runPluginSessionStateDoctorRepairs,
  scanSessionRouteStateOwners,
  storeMayContainPluginSessionRouteState,
} from "./doctor-session-state-providers.js";

vi.mock("../plugins/doctor-contract-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/doctor-contract-registry.js")>(
    "../plugins/doctor-contract-registry.js",
  );
  return {
    ...actual,
    listPluginDoctorSessionRouteStateOwners: vi.fn(() => [
      {
        id: "codex",
        label: "Codex",
        providerIds: ["codex", "codex-cli", "openai-codex"],
        runtimeIds: ["codex", "codex-cli"],
        cliSessionKeys: ["codex-cli"],
        authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
      },
    ]),
  };
});

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

    expect(
      storeMayContainPluginSessionRouteState({
        "agent:main:telegram:direct:2": {
          sessionId: "session-claude-cli",
          updatedAt: 1,
          agentRuntimeOverride: "claude-cli",
        },
      }),
    ).toBe(true);
  });

  it("skips valid locked agent-harness rows during scan and repair", async () => {
    const sessionKey = "agent:main:ordinary-locked";
    const entry: Record<string, unknown> = {
      sessionId: "sess-supervised-codex",
      updatedAt: 1,
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      cliSessionBindings: {
        "codex-cli": { sessionId: "native-codex-session" },
      },
    };
    const original = structuredClone(entry);
    const store = { [sessionKey]: entry };
    const route = {
      defaultProvider: "github-copilot",
      configuredModelRefs: ["github-copilot/gpt-5-mini"],
      runtime: "openclaw",
    };

    expect(
      storeMayContainPluginSessionRouteState(
        store as unknown as Parameters<typeof storeMayContainPluginSessionRouteState>[0],
      ),
    ).toBe(false);
    expect(
      scanSessionRouteStateOwners({
        owners: [codexOwner],
        store,
        routes: { [sessionKey]: route },
      }),
    ).toEqual({ repairs: [], manualReview: [] });
    expect(
      applySessionRouteStateRepair({
        sessionKey,
        entry,
        repair: {
          key: sessionKey,
          ownerId: "codex",
          ownerLabel: "Codex",
          reasons: ["auto model override", "pinned runtime", "runtime model state"],
          pinnedRuntimeKeys: ["agentHarnessId"],
          cliSessionKeys: ["codex-cli"],
        },
        now: 123,
      }),
    ).toBe(false);

    const warnings: string[] = [];
    const changes: string[] = [];
    const prompter: Parameters<typeof runPluginSessionStateDoctorRepairs>[0]["prompter"] = {
      confirmRuntimeRepair: vi.fn(async () => true),
      note: vi.fn(),
    };
    await runPluginSessionStateDoctorRepairs({
      cfg: {},
      store: store as unknown as Parameters<typeof runPluginSessionStateDoctorRepairs>[0]["store"],
      absoluteStorePath: "/tmp/nonexistent-supervised-store.json",
      prompter,
      env: {},
      warnings,
      changes,
    });

    expect(entry).toEqual(original);
    expect(warnings).toStrictEqual([]);
    expect(changes).toStrictEqual([]);
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
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
            agentRuntime: { id: "openclaw" },
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
          runtime: "openclaw",
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
        pinnedRuntimeKeys: ["agentHarnessId"],
        reasons: [
          "auto model override",
          "pinned runtime",
          "runtime model state",
          "CLI session binding",
          "auto auth profile override",
        ],
      },
    ]);

    expect(
      applySessionRouteStateRepair({ sessionKey, entry, repair: scan.repairs[0], now: 123 }),
    ).toBe(true);
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
          runtime: "openclaw",
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

  it("clears stale runtime pins while preserving configured owner model state", () => {
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
          runtime: "openclaw",
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
        pinnedRuntimeKeys: ["agentHarnessId"],
        reasons: ["pinned runtime"],
      },
    ]);

    expect(
      applySessionRouteStateRepair({ sessionKey, entry, repair: scan.repairs[0], now: 123 }),
    ).toBe(true);
    expect(entry.updatedAt).toBe(123);
    expect(entry.providerOverride).toBe("openai-codex");
    expect(entry.modelOverride).toBe("gpt-5.4");
    expect(entry.modelProvider).toBe("openai-codex");
    expect(entry.model).toBe("gpt-5.4");
    expect(entry.agentHarnessId).toBeUndefined();
    expect(entry.cliSessionBindings).toStrictEqual({
      "codex-cli": { sessionId: "codex-session-3" },
    });
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

  it("clears stale agentRuntimeOverride-only pins when current route no longer uses the owner", () => {
    const sessionKey = "agent:main:telegram:direct:5";
    const entry: Record<string, unknown> = {
      sessionId: "sess-stale-claude-cli",
      updatedAt: 1,
      agentRuntimeOverride: "claude-cli",
    };

    const scan = scanSessionRouteStateOwners({
      owners: [
        {
          id: "anthropic",
          label: "Anthropic",
          providerIds: ["anthropic"],
          runtimeIds: ["claude-cli"],
          cliSessionKeys: ["claude-cli"],
          authProfilePrefixes: ["anthropic:", "claude-cli:"],
        },
      ],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "openai",
          configuredModelRefs: ["openai/gpt-5.5"],
          runtime: "openclaw",
        },
      },
    });

    expect(scan.manualReview).toStrictEqual([]);
    expect(scan.repairs).toEqual([
      {
        key: sessionKey,
        ownerId: "anthropic",
        ownerLabel: "Anthropic",
        cliSessionKeys: ["claude-cli"],
        pinnedRuntimeKeys: ["agentRuntimeOverride"],
        reasons: ["pinned runtime"],
      },
    ]);

    expect(
      applySessionRouteStateRepair({ sessionKey, entry, repair: scan.repairs[0], now: 123 }),
    ).toBe(true);
    expect(entry.sessionId).toBe("sess-stale-claude-cli");
    expect(entry.updatedAt).toBe(123);
    expect(entry.agentRuntimeOverride).toBeUndefined();
  });

  it("keeps agentRuntimeOverride pins when owner runtime remains configured", () => {
    const sessionKey = "agent:main:telegram:direct:6";
    const entry: Record<string, unknown> = {
      sessionId: "sess-active-claude-cli",
      updatedAt: 1,
      agentRuntimeOverride: "claude-cli",
    };

    const scan = scanSessionRouteStateOwners({
      owners: [
        {
          id: "anthropic",
          label: "Anthropic",
          providerIds: ["anthropic"],
          runtimeIds: ["claude-cli"],
          cliSessionKeys: ["claude-cli"],
          authProfilePrefixes: ["anthropic:", "claude-cli:"],
        },
      ],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "anthropic",
          configuredModelRefs: ["anthropic/claude-opus-4.7"],
          runtime: "claude-cli",
        },
      },
    });

    expect(scan).toEqual({ repairs: [], manualReview: [] });
  });

  it("clears stale owner runtime pins when owner provider remains configured", () => {
    const sessionKey = "agent:main:telegram:direct:7";
    const entry: Record<string, unknown> = {
      sessionId: "sess-provider-active-runtime-stale",
      updatedAt: 1,
      agentRuntimeOverride: "claude-cli",
    };

    const scan = scanSessionRouteStateOwners({
      owners: [
        {
          id: "anthropic",
          label: "Anthropic",
          providerIds: ["anthropic"],
          runtimeIds: ["claude-cli"],
          cliSessionKeys: ["claude-cli"],
          authProfilePrefixes: ["anthropic:", "claude-cli:"],
        },
      ],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "anthropic",
          configuredModelRefs: ["anthropic/claude-opus-4.7"],
          runtime: "openclaw",
        },
      },
    });

    expect(scan.manualReview).toStrictEqual([]);
    expect(scan.repairs).toEqual([
      {
        key: sessionKey,
        ownerId: "anthropic",
        ownerLabel: "Anthropic",
        cliSessionKeys: ["claude-cli"],
        pinnedRuntimeKeys: ["agentRuntimeOverride"],
        reasons: ["pinned runtime"],
      },
    ]);

    expect(
      applySessionRouteStateRepair({ sessionKey, entry, repair: scan.repairs[0], now: 123 }),
    ).toBe(true);
    expect(entry.updatedAt).toBe(123);
    expect(entry.agentRuntimeOverride).toBeUndefined();
  });

  it("preserves non-owner runtime overrides when clearing owner harness pins", () => {
    const sessionKey = "agent:main:telegram:direct:8";
    const entry: Record<string, unknown> = {
      sessionId: "sess-mixed-runtime-pins",
      updatedAt: 1,
      agentHarnessId: "codex-cli",
      agentRuntimeOverride: "claude-cli",
    };

    const scan = scanSessionRouteStateOwners({
      owners: [codexOwner],
      store: { [sessionKey]: entry },
      routes: {
        [sessionKey]: {
          defaultProvider: "openai",
          configuredModelRefs: ["openai/gpt-5.5"],
          runtime: "openclaw",
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
        pinnedRuntimeKeys: ["agentHarnessId"],
        reasons: ["pinned runtime"],
      },
    ]);

    expect(
      applySessionRouteStateRepair({ sessionKey, entry, repair: scan.repairs[0], now: 123 }),
    ).toBe(true);
    expect(entry.updatedAt).toBe(123);
    expect(entry.agentHarnessId).toBeUndefined();
    expect(entry.agentRuntimeOverride).toBe("claude-cli");
  });

  it("skips entries without plugin route state and memoizes routes per agentId", async () => {
    // Sentinel cfg makes resolveConfiguredDoctorSessionStateRoute cheap and
    // deterministic. The important assertions are observable through the
    // resulting scan: entries with no route-state fields contribute no
    // repairs/manual-review and the run completes immediately.
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4" },
        },
      },
      models: {
        providers: {
          anthropic: {},
        },
      },
    } as unknown as Parameters<typeof runPluginSessionStateDoctorRepairs>[0]["cfg"];

    // Build a store with 200 entries belonging to one agent. Two carry route
    // state that the codex owner cares about; the rest are bare. The old
    // implementation resolved a route for all 200; the new one only resolves
    // for the 2 that matter, deduplicated by agentId.
    const store: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 198; i += 1) {
      store[`agent:main:bare-${i}`] = {
        sessionId: `sess-bare-${i}`,
        updatedAt: i,
        // No providerOverride/model/agentHarnessId/etc. — must be skipped.
      };
    }
    store["agent:main:codex-1"] = {
      sessionId: "sess-codex-1",
      updatedAt: 1,
      agentHarnessId: "codex-cli",
    };
    store["agent:main:codex-2"] = {
      sessionId: "sess-codex-2",
      updatedAt: 2,
      agentHarnessId: "codex-cli",
    };

    const warnings: string[] = [];
    const changes: string[] = [];
    const prompter: Parameters<typeof runPluginSessionStateDoctorRepairs>[0]["prompter"] = {
      confirmRuntimeRepair: vi.fn(async () => false),
      note: vi.fn(),
    };

    const start = Date.now();
    await runPluginSessionStateDoctorRepairs({
      cfg,
      store: store as unknown as Parameters<typeof runPluginSessionStateDoctorRepairs>[0]["store"],
      absoluteStorePath: "/tmp/nonexistent-store.json",
      prompter,
      env: {},
      warnings,
      changes,
    });
    const elapsedMs = Date.now() - start;

    // Two entries flagged for pinned-runtime repair; warning emitted once.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Codex/);
    expect(warnings[0]).toMatch(/2 sessions?/);

    // User declined the repair so no changes applied.
    expect(changes).toHaveLength(0);
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledOnce();

    // Sanity check: even with 200 entries, this should complete near-
    // instantly because route resolution is bounded by unique agentIds, not
    // by store size. A 200-entry x 1.6s-per-call pre-fix run would exceed
    // 5 minutes; the fixed code should run in well under a second.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
