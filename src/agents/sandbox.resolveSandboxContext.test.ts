import { describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";

describe("resolveSandboxContext", () => {
  it("does not sandbox the agent main session in non-main mode", async () => {
    vi.resetModules();

    const spawn = vi.fn(() => {
      throw new Error("spawn should not be called");
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn };
    });

    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
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
      workspaceDir: "/tmp/moltbot-test",
    });

    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();

    vi.doUnmock("node:child_process");
  }, 15_000);

  it("does not create a sandbox workspace for the agent main session in non-main mode", async () => {
    vi.resetModules();

    const spawn = vi.fn(() => {
      throw new Error("spawn should not be called");
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn };
    });

    const { ensureSandboxWorkspaceForSession } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
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
      workspaceDir: "/tmp/moltbot-test",
    });

    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();

    vi.doUnmock("node:child_process");
  }, 15_000);

  it("treats main session aliases as main in non-main mode", async () => {
    vi.resetModules();

    const spawn = vi.fn(() => {
      throw new Error("spawn should not be called");
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn };
    });

    const { ensureSandboxWorkspaceForSession, resolveSandboxContext } =
      await import("./sandbox.js");

    const cfg: MoltbotConfig = {
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
        workspaceDir: "/tmp/moltbot-test",
      }),
    ).toBeNull();

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/moltbot-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "work",
        workspaceDir: "/tmp/moltbot-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/moltbot-test",
      }),
    ).toBeNull();

    expect(spawn).not.toHaveBeenCalled();

    vi.doUnmock("node:child_process");
  }, 15_000);
});
