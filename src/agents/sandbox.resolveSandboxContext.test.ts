import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox/context.js";

const updateRegistryMock = vi.hoisted(() => vi.fn());
const syncSkillsToWorkspaceMock = vi.hoisted(() => vi.fn(async () => undefined));
const ensureSandboxBrowserMock = vi.hoisted(() => vi.fn(async () => null));
const browserControlAuthMock = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => ({ auth: { token: "test-browser-token" } })),
  resolveBrowserControlAuth: vi.fn(() => ({ token: "test-browser-token" })),
}));
const browserProfilesMock = vi.hoisted(() => ({
  DEFAULT_BROWSER_EVALUATE_ENABLED: true,
  resolveBrowserConfig: vi.fn(() => ({
    evaluateEnabled: true,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  })),
}));

vi.mock("./sandbox/registry.js", () => ({
  updateRegistry: updateRegistryMock,
}));

vi.mock("./sandbox/browser.js", () => ({
  ensureSandboxBrowser: ensureSandboxBrowserMock,
}));

vi.mock("../plugin-sdk/browser-control-auth.js", () => browserControlAuthMock);

vi.mock("../plugin-sdk/browser-profiles.js", () => browserProfilesMock);

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => ({ note: "test-remote" })),
}));

vi.mock("./exec-defaults.js", () => ({
  canExecRequestNode: vi.fn(() => false),
}));

vi.mock("./skills.js", () => ({
  syncSkillsToWorkspace: syncSkillsToWorkspaceMock,
}));

let sandboxFixtureRoot = "";
let sandboxFixtureCount = 0;

async function createSandboxFixtureDir(prefix: string): Promise<string> {
  const dir = path.join(sandboxFixtureRoot, `${prefix}-${sandboxFixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  sandboxFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-context-"));
});

afterAll(async () => {
  await fs.rm(sandboxFixtureRoot, { recursive: true, force: true });
});

describe("resolveSandboxContext", () => {
  it("does not sandbox the agent main session in non-main mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("does not create a sandbox workspace for the agent main session in non-main mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("treats main session aliases as main in non-main mode", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "work" },
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "work",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();
  }, 15_000);

  it("resolves a registered non-docker backend", async () => {
    const restore = registerSandboxBackend("test-backend", async () => ({
      id: "test-backend",
      runtimeId: "test-runtime",
      runtimeLabel: "Test Runtime",
      workdir: "/workspace",
      buildExecSpec: async () => ({
        argv: ["test-backend", "exec"],
        env: process.env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "test-backend",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      };

      const result = await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:worker:task",
        workspaceDir: "/tmp/openclaw-test",
      });

      expect(result?.backendId).toBe("test-backend");
      expect(result?.runtimeId).toBe("test-runtime");
      expect(result?.containerName).toBe("test-runtime");
      expect(result?.backend?.id).toBe("test-backend");
    } finally {
      restore();
    }
  }, 15_000);

  it("passes the resolved browser SSRF policy to sandbox browser setup", async () => {
    ensureSandboxBrowserMock.mockClear();
    const restore = registerSandboxBackend("test-browser-backend", async () => ({
      id: "test-browser-backend",
      runtimeId: "test-browser-runtime",
      runtimeLabel: "Test Browser Runtime",
      workdir: "/workspace",
      capabilities: { browser: true },
      buildExecSpec: async () => ({
        argv: ["test-browser-backend", "exec"],
        env: process.env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    try {
      const cfg: OpenClawConfig = {
        browser: {
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        },
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "test-browser-backend",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
              browser: { enabled: true },
            },
          },
        },
      };

      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:worker:browser",
        workspaceDir: "/tmp/openclaw-test",
      });

      expect(ensureSandboxBrowserMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        }),
      );
    } finally {
      restore();
    }
  }, 15_000);

  it("requests skill sync for read-only sandbox workspaces", async () => {
    syncSkillsToWorkspaceMock.mockClear();
    const bundledDir = await createSandboxFixtureDir("bundled");
    const workspaceDir = await createSandboxFixtureDir("workspace");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess: "ro",
            workspaceRoot: path.join(bundledDir, "sandboxes"),
          },
        },
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    expect(result).not.toBeNull();
    expect(syncSkillsToWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceWorkspaceDir: workspaceDir,
        targetWorkspaceDir: result?.workspaceDir,
        config: cfg,
        agentId: "main",
        eligibility: { remote: { note: "test-remote" } },
      }),
    );
  }, 15_000);
});
