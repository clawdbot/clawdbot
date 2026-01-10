import { describe, expect, it, vi } from "vitest";

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
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveMainSessionKey: mocks.resolveMainSessionKey,
  resolveStorePath: mocks.resolveStorePath,
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
vi.mock("../gateway/session-utils.js", () => ({
  listAgentsForGateway: () => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Main" }],
  }),
}));
vi.mock("../infra/clawdbot-root.js", () => ({
  resolveClawdbotPackageRoot: vi.fn().mockResolvedValue("/tmp/clawdbot"),
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
    root: "/tmp/clawdbot",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/tmp/clawdbot",
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
      lockfilePath: "/tmp/clawdbot/pnpm-lock.yaml",
      markerPath: "/tmp/clawdbot/node_modules/.modules.yaml",
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
    expect(payload.web.linked).toBe(true);
    expect(payload.sessions.count).toBe(1);
    expect(payload.sessions.path).toBe("/tmp/sessions.json");
    expect(payload.sessions.defaults.model).toBeTruthy();
    expect(payload.sessions.defaults.contextTokens).toBeGreaterThan(0);
    expect(payload.sessions.recent[0].percentUsed).toBe(50);
    expect(payload.sessions.recent[0].remainingTokens).toBe(5000);
    expect(payload.sessions.recent[0].flags).toContain("verbose:on");
  });

  it("prints formatted lines otherwise", async () => {
    (runtime.log as vi.Mock).mockClear();
    await statusCommand({}, runtime as never);
    const logs = (runtime.log as vi.Mock).mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("Clawdbot status"))).toBe(true);
    expect(logs.some((l) => l.includes("Overview"))).toBe(true);
    expect(logs.some((l) => l.includes("Dashboard"))).toBe(true);
    expect(logs.some((l) => l.includes("macos 14.0 (arm64)"))).toBe(true);
    expect(logs.some((l) => l.includes("Providers"))).toBe(true);
    expect(logs.some((l) => l.includes("Telegram"))).toBe(true);
    expect(logs.some((l) => l.includes("Sessions"))).toBe(true);
    expect(logs.some((l) => l.includes("+1000"))).toBe(true);
    expect(logs.some((l) => l.includes("50%"))).toBe(true);
    expect(logs.some((l) => l.includes("LaunchAgent"))).toBe(true);
    expect(logs.some((l) => l.includes("FAQ:"))).toBe(true);
    expect(logs.some((l) => l.includes("Troubleshooting:"))).toBe(true);
  });
});
