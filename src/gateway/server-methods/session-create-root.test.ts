import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";

const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

describe("session create filesystem root", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let cfg: OpenClawConfig;
  let workspace: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-session-root-", layout: "split" });
    workspace = state.workspaceDir;
    await fs.mkdir(path.join(workspace, "project"));
    await fs.mkdir(state.path("outside", "project"), { recursive: true });
    await fs.symlink(workspace, state.path("workspace-alias"), directoryLinkType);
    await fs.symlink(
      path.join(workspace, "project"),
      state.path("candidate-alias"),
      directoryLinkType,
    );
    await fs.symlink(
      path.join(workspace, "project"),
      path.join(workspace, "internal"),
      directoryLinkType,
    );
    await fs.symlink(state.path("outside"), path.join(workspace, "escape"), directoryLinkType);
    await fs.symlink(
      path.join(workspace, "missing"),
      path.join(workspace, "dangling"),
      directoryLinkType,
    );
    await fs.symlink(
      state.path("outside", "missing"),
      path.join(workspace, "dangling-out"),
      directoryLinkType,
    );
    cfg = {
      agents: {
        defaults: { sandbox: { mode: "all" } },
        entries: { main: { workspace }, other: { workspace: state.path("outside") } },
      },
      session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.json") },
    };
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each([
    ["canonical child", "workspace", "workspace/project", "workspace/project"],
    ["configured workspace alias", "workspace-alias", "workspace/project", "workspace/project"],
    ["candidate alias", "workspace", "candidate-alias", "workspace/project"],
    ["workspace itself", "workspace-alias", "workspace", "workspace"],
    ["internal symlink", "workspace", "workspace/internal", "workspace/project"],
  ])("admits %s and returns the canonical root", (_name, configured, cwd, expected) => {
    cfg.agents!.entries!.main!.workspace = state.path(configured);
    expect(
      prepareSessionCreateFilesystemRoot({
        cfg,
        targetAgentId: "main",
        enforceSandboxContainment: true,
        sessionCwd: state.path(cwd),
      }),
    ).toEqual({
      ok: true,
      value: { sessionRoot: state.path(expected), sessionCwd: state.path(expected) },
    });
  });

  it.each([
    ["another agent workspace", "outside/project"],
    ["leaf symlink escape", "workspace/escape"],
    ["ancestor symlink escape", "workspace/escape/project"],
  ])("rejects %s against only the selected agent", (_name, cwd) => {
    expect(
      prepareSessionCreateFilesystemRoot({
        cfg,
        targetAgentId: "main",
        enforceSandboxContainment: true,
        sessionCwd: state.path(cwd),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create cwd is outside the sandboxed agent workspace",
      },
    });
  });

  it.each([
    ["missing cwd", "workspace", "workspace/missing"],
    ["dangling inward link", "workspace", "workspace/dangling"],
    ["dangling outward link", "workspace", "workspace/dangling-out"],
    ["missing workspace", "missing-workspace", "workspace/project"],
  ])("fails closed for %s without creating the missing path", async (_name, configured, cwd) => {
    cfg.agents!.entries!.main!.workspace = state.path(configured);
    expect(
      prepareSessionCreateFilesystemRoot({
        cfg,
        targetAgentId: "main",
        enforceSandboxContainment: true,
        sessionCwd: state.path(cwd),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("cwd is unavailable:") },
    });
    await expect(fs.stat(path.join(workspace, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(state.path("missing-workspace"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["worktree exemption", "all", false, undefined, true],
    ["sandbox off", "off", true, undefined, true],
    ["non-main main session", "non-main", true, "agent:main:main", true],
    ["non-main generated session", "non-main", true, undefined, false],
  ] as const)("preserves %s", (_name, mode, enforceSandboxContainment, sessionKey, allowed) => {
    cfg.agents!.defaults!.sandbox = { mode };
    const result = prepareSessionCreateFilesystemRoot({
      cfg,
      targetAgentId: "main",
      enforceSandboxContainment,
      sessionKey,
      sessionCwd: state.path("outside"),
    });
    expect(result.ok).toBe(allowed);
    if (allowed) {
      expect(result).toMatchObject({ value: { sessionRoot: state.path("outside") } });
    }
  });

  it("creates an omitted workspace through its alias and leaves cwd unset", async () => {
    const missing = state.path("workspace-alias", "new-workspace");
    cfg.agents!.entries!.main!.workspace = missing;
    expect(
      prepareSessionCreateFilesystemRoot({
        cfg,
        targetAgentId: "main",
        enforceSandboxContainment: true,
      }),
    ).toEqual({
      ok: true,
      value: { sessionRoot: path.join(workspace, "new-workspace"), sessionCwd: undefined },
    });
    expect((await fs.stat(missing)).isDirectory()).toBe(true);
  });

  it("does not resolve remote node paths on the Gateway", () => {
    const sessionCwd = "C:\\remote\\missing";
    expect(
      prepareSessionCreateFilesystemRoot({
        cfg,
        targetAgentId: "main",
        enforceSandboxContainment: true,
        requestedExecNode: "remote",
        sessionCwd,
      }),
    ).toEqual({ ok: true, value: { sessionCwd } });
  });
});
