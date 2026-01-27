import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let previousProfile: string | undefined;

beforeAll(() => {
  previousProfile = process.env.CLAWDBOT_PROFILE;
  process.env.CLAWDBOT_PROFILE = "isolated";
});

afterAll(() => {
  if (previousProfile === undefined) {
    delete process.env.CLAWDBOT_PROFILE;
  } else {
    process.env.CLAWDBOT_PROFILE = previousProfile;
  }
});

const mocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn().mockReturnValue({
    "+1000": {
      updatedAt: Date.now() - 60_000,
      verboseLevel: "on",
      thinkingLevel: "low",
      inputTokens: 2_000,
      outputTokens: 3_000,
      contextTokens: 10_000,
      model: "pi:opus",
      sessionId: "abc123",
      systemSent: true,
    },
  }),
  resolveMainSessionKey: vi.fn().mockReturnValue("agent:main:main"),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(5000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
  logWebSelfId: vi.fn(),
  probeGateway: vi.fn().mockResolvedValue({
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  }),
  callGateway: vi.fn().mockResolvedValue({}),
  listAgentsForGateway: vi.fn().mockReturnValue({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Main" }],
  }),
  runSecurityAudit: vi.fn().mockResolvedValue({
    ts: 0,
    summary: { critical: 1, warn: 1, info: 2 },
    findings: [
      {
        checkId: "test.critical",
        severity: "critical",
        title: "Test critical finding",
        detail: "Something is very wrong\nbut on two lines",
        remediation: "Do the thing",
      },
      {
        checkId: "test.warn",
        severity: "warn",
        title: "Test warning finding",
        detail: "Something is maybe wrong",
      },
      {
        checkId: "test.info",
        severity: "info",
        title: "Test info finding",
        detail: "FYI only",
      },
      {
        checkId: "test.info2",
        severity: "info",
        title: "Another info finding",
        detail: "More FYI",
      },
    ],
  }),
}));

vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: vi.fn(async ({ agentId }: { agentId: string }) => ({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => ({
        files: 2,
        chunks: 3,
        dirty: false,
        workspaceDir: "/tmp/clawd",
        dbPath: "/tmp/memory.sqlite",
        provider: "openai",
        model: "text-embedding-3-small",
        requestedProvider: "openai",
        sources: ["memory"],
        sourceCounts: [{ source: "memory", files: 2, chunks: 3 }],
        cache: { enabled: true, entries: 10, maxEntries: 500 },
        fts: { enabled: true, available: true },
        vector: { enabled: true, available: true, extensionPath: "/opt/vec0.dylib", dims: 1024 },
      }),
      close: vi.fn(async () => {}),
      __agentId: agentId,
    })),
  },
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveMainSessionKey: mocks.resolveMainSessionKey,
  resolveStorePath: mocks.resolveStorePath,
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () =>
    [
      {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/platforms/whatsapp",
          blurb: "mock",
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        status: {
          buildChannelSummary: async () => ({ linked: true, authAgeMs: 5000 }),
        },
      },
      {
        id: "signal",
        meta: {
          id: "signal",
          label: "Signal",
          selectionLabel: "Signal",
          docsPath: "/platforms/signal",
          blurb: "mock",
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        status: {
          collectStatusIssues: (accounts: Array<Record<string, unknown>>) =>
            accounts
              .filter((account) => typeof account.lastError === "string" && account.lastError)
              .map((account) => ({
                channel: "signal",
                accountId: typeof account.accountId === "string" ? account.accountId : "default",
                message: `Channel error: ${String(account.lastError)}`,
              })),
        },
      },
      {
        id: "imessage",
        meta: {
          id: "imessage",
          label: "iMessage",
          selectionLabel: "iMessage",
          docsPath: "/platforms/mac",
          blurb: "mock",
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        status: {
          collectStatusIssues: (accounts: Array<Record<string, unknown>>) =>
            accounts
              .filter((account) => typeof account.lastError === "string" && account.lastError)
              .map((account) => ({
                channel: "imessage",
                accountId: typeof account.accountId === "string" ? account.accountId : "default",
                message: `Channel error: ${String(account.lastError)}`,
              })),
        },
      },
    ] as unknown,
}));
vi.mock("../web/session.js", () => ({
  webAuthExists: mocks.webAuthExists,
  getWebAuthAgeMs: mocks.getWebAuthAgeMs,
  readWebSelfId: mocks.readWebSelfId,
  logWebSelfId: mocks.logWebSelfId,
}));
vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));
vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: mocks.callGateway };
});
vi.mock("../gateway/session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
}));
vi.mock("../infra/moltbot-root.js", () => ({
  resolveMoltbotPackageRoot: vi.fn().mockResolvedValue("/tmp/moltbot"),
}));
vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: () => ({
    platform: "darwin",
    arch: "arm64",
    release: "23.0.0",
    label: "macos 14.0 (arm64)",
  }),
}));
vi.mock("../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn().mockResolvedValue({
    root: "/tmp/moltbot",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/tmp/moltbot",
      branch: "main",
      upstream: "origin/main",
      dirty: false,
      ahead: 0,
      behind: 0,
      fetchOk: true,
    },
    deps: {
      manager: "pnpm",
      status: "ok",
      lockfilePath: "/tmp/moltbot/pnpm-lock.yaml",
      markerPath: "/tmp/moltbot/node_modules/.modules.yaml",
    },
    registry: { latestVersion: "0.0.0" },
  }),
  compareSemverStrings: vi.fn(() => 0),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({ session: {} }),
  };
});
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 1234 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "gateway"],
      sourcePath: "/tmp/Library/LaunchAgents/com.clawdbot.gateway.plist",
    }),
  }),
}));
vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 4321 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "node-host"],
      sourcePath: "/tmp/Library/LaunchAgents/com.clawdbot.node.plist",
    }),
  }),
}));
vi.mock("../security/audit.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

import { statusCommand } from "./status.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("statusCommand", () => {
  it("prints JSON when requested", async () => {
    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse((runtime.log as vi.Mock).mock.calls[0][0]);
    expect(payload.linkChannel.linked).toBe(true);
    expect(payload.memory.agentId).toBe("main");
    expect(payload.memoryPlugin.enabled).toBe(true);
    expect(payload.memoryPlugin.slot).toBe("memory-core");
    expect(payload.memory.vector.available).toBe(true);
    expect(payload.sessions.count).toBe(1);
    expect(payload.sessions.paths).toContain("/tmp/sessions.json");
    expect(payload.sessions.defaults.model).toBeTruthy();
    expect(payload.sessions.defaults.contextTokens).toBeGreaterThan(0);
    expect(payload.sessions.recent[0].percentUsed).toBe(50);
    expect(payload.sessions.recent[0].remainingTokens).toBe(5000);
    expect(payload.sessions.recent[0].flags).toContain("verbose:on");
    expect(payload.securityAudit.summary.critical).toBe(1);
    expect(payload.securityAudit.summary.warn).toBe(1);
    expect(payload.gatewayService.label).toBe("LaunchAgent");
    expect(payload.nodeService.label).toBe("LaunchAgent");
  });

  it("prints formatted lines otherwise", async () => {
    (runtime.log as vi.Mock).mockClear();
    await statusCommand({}, runtime as never);
    const logs = (runtime.log as vi.Mock).mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("Moltbot status"))).toBe(true);
    expect(logs.some((l) => l.includes("Overview"))).toBe(true);
    expect(logs.some((l) => l.includes("Security audit"))).toBe(true);
    expect(logs.some((l) => l.includes("Summary:"))).toBe(true);
    expect(logs.some((l) => l.includes("CRITICAL"))).toBe(true);
    expect(logs.some((l) => l.includes("Dashboard"))).toBe(true);
    expect(logs.some((l) => l.includes("macos 14.0 (arm64)"))).toBe(true);
    expect(logs.some((l) => l.includes("Memory"))).toBe(true);
    expect(logs.some((l) => l.includes("Channels"))).toBe(true);
    expect(logs.some((l) => l.includes("WhatsApp"))).toBe(true);
    expect(logs.some((l) => l.includes("Sessions"))).toBe(true);
    expect(logs.some((l) => l.includes("+1000"))).toBe(true);
    expect(logs.some((l) => l.includes("50%"))).toBe(true);
    expect(logs.some((l) => l.includes("LaunchAgent"))).toBe(true);
    expect(logs.some((l) => l.includes("FAQ:"))).toBe(true);
    expect(logs.some((l) => l.includes("Troubleshooting:"))).toBe(true);
    expect(logs.some((l) => l.includes("Next steps:"))).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes("moltbot status --all") ||
          l.includes("moltbot --profile isolated status --all") ||
          l.includes("moltbot status --all") ||
          l.includes("moltbot --profile isolated status --all"),
      ),
    ).toBe(true);
  });

  it("shows gateway auth when reachable", async () => {
    const prevToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
    process.env.CLAWDBOT_GATEWAY_TOKEN = "abcd1234";
    try {
      mocks.probeGateway.mockResolvedValueOnce({
        ok: true,
        url: "ws://127.0.0.1:18789",
        connectLatencyMs: 123,
        error: null,
        close: null,
        health: {},
        status: {},
        presence: [],
        configSnapshot: null,
      });
      (runtime.log as vi.Mock).mockClear();
      await statusCommand({}, runtime as never);
      const logs = (runtime.log as vi.Mock).mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes("auth token"))).toBe(true);
    } finally {
      if (prevToken === undefined) delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      else process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
  });

  it("surfaces channel runtime errors from the gateway", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 10,
      error: null,
      close: null,
      health: {},
      status: {},
      presence: [],
      configSnapshot: null,
    });
    mocks.callGateway.mockResolvedValueOnce({
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imessage permission denied",
          },
        ],
      },
    });

    (runtime.log as vi.Mock).mockClear();
    await statusCommand({}, runtime as never);
    const logs = (runtime.log as vi.Mock).mock.calls.map((c) => String(c[0]));
    expect(logs.join("\n")).toMatch(/Signal/i);
    expect(logs.join("\n")).toMatch(/iMessage/i);
    expect(logs.join("\n")).toMatch(/gateway:/i);
    expect(logs.join("\n")).toMatch(/WARN/);
  });

  it("includes sessions across agents in JSON output", async () => {
    const originalAgents = mocks.listAgentsForGateway.getMockImplementation();
    const originalResolveStorePath = mocks.resolveStorePath.getMockImplementation();
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();

    mocks.listAgentsForGateway.mockReturnValue({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    });
    mocks.resolveStorePath.mockImplementation((_store, opts) =>
      opts?.agentId === "ops" ? "/tmp/ops.json" : "/tmp/main.json",
    );
    mocks.loadSessionStore.mockImplementation((storePath) => {
      if (storePath === "/tmp/ops.json") {
        return {
          "agent:ops:main": {
            updatedAt: Date.now() - 120_000,
            inputTokens: 1_000,
            outputTokens: 1_000,
            contextTokens: 10_000,
            model: "pi:opus",
          },
        };
      }
      return {
        "+1000": {
          updatedAt: Date.now() - 60_000,
          verboseLevel: "on",
          thinkingLevel: "low",
          inputTokens: 2_000,
          outputTokens: 3_000,
          contextTokens: 10_000,
          model: "pi:opus",
          sessionId: "abc123",
          systemSent: true,
        },
      };
    });

    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse((runtime.log as vi.Mock).mock.calls.at(-1)?.[0]);
    expect(payload.sessions.count).toBe(2);
    expect(payload.sessions.paths.length).toBe(2);
    expect(
      payload.sessions.recent.some((sess: { key?: string }) => sess.key === "agent:ops:main"),
    ).toBe(true);

    if (originalAgents) mocks.listAgentsForGateway.mockImplementation(originalAgents);
    if (originalResolveStorePath)
      mocks.resolveStorePath.mockImplementation(originalResolveStorePath);
    if (originalLoadSessionStore)
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
  });
});
