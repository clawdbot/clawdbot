// Doctor Claude CLI tests cover CLI discovery, version checks, and repair guidance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { noteClaudeCliHealth } from "./doctor-claude-cli.js";

function createStore(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

async function withTempHome<T>(
  run: (params: { homeDir: string; workspaceDir: string }) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-claude-cli-"));
  const homeDir = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    return await run({ homeDir, workspaceDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function noteArg(noteFn: ReturnType<typeof vi.fn>, argIndex: number): unknown {
  const call = noteFn.mock.calls[0];
  if (!call) {
    throw new Error("Expected note call");
  }
  return call.at(argIndex);
}

function noteBody(noteFn: ReturnType<typeof vi.fn>): string {
  const value = noteArg(noteFn, 0);
  if (typeof value !== "string") {
    throw new Error("Expected note body");
  }
  return value;
}

function noteTitle(noteFn: ReturnType<typeof vi.fn>): string {
  const value = noteArg(noteFn, 1);
  if (typeof value !== "string") {
    throw new Error("Expected note title");
  }
  return value;
}

function noteHealthyClaudeCliDirectories(params: {
  homeDir: string;
  workspaceDir: string;
}): ReturnType<typeof vi.fn> {
  const noteFn = vi.fn();
  noteClaudeCliHealth(
    {
      agents: {
        defaults: { model: { primary: "claude-cli/claude-sonnet-4-6" } },
        entries: { main: { default: true } },
      },
    },
    {
      ...params,
      noteFn,
      store: createStore(),
      readClaudeCliCredentials: () => ({ type: "api_key_helper" }),
      resolveCommandPath: () => "/opt/homebrew/bin/claude",
    },
  );
  return noteFn;
}

describe("resolveClaudeCliProjectDirForWorkspace", () => {
  it("matches Claude's sanitized workspace project dir shape", () => {
    expect(
      resolveClaudeCliProjectDirForWorkspace({
        workspaceDir: "/Users/vincentkoc/GIT/_Perso/openclaw/.openclaw/workspace",
        homeDir: "/Users/vincentkoc",
      }),
    ).toBe(
      "/Users/vincentkoc/.claude/projects/-Users-vincentkoc-GIT--Perso-openclaw--openclaw-workspace",
    );
  });
});

describe("noteClaudeCliHealth", () => {
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    vi.restoreAllMocks();
  });

  it("probes the executable registered by the owning backend plugin", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            pluginId: "custom-anthropic",
            config: { command: "/opt/custom/bin/claude" },
          },
        ],
      });
      const resolveCommandPath = vi.fn(() => undefined);

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: "claude-cli/claude-sonnet-4-6" },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn: vi.fn(),
          store: createStore(),
          readClaudeCliCredentials: () => null,
          resolveCommandPath,
        },
      );

      expect(resolveCommandPath).toHaveBeenCalledWith("/opt/custom/bin/claude", expect.any(Object));
    });
  });

  it("stays quiet when Claude CLI is not configured or detected", () => {
    const noteFn = vi.fn();
    noteClaudeCliHealth(
      {},
      {
        noteFn,
        store: createStore(),
        readClaudeCliCredentials: () => null,
      },
    );
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("stays quiet for a healthy claude-cli setup", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
      fs.mkdirSync(projectDir, { recursive: true });

      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          store: createStore({
            [CLAUDE_CLI_PROFILE_ID]: {
              type: "oauth",
              provider: "claude-cli",
              access: "test-auth-token",
              refresh: "test-token-placeholder",
              expires: Date.now() + 60_000,
            },
          }),
          readClaudeCliCredentials: () => ({
            type: "oauth",
            expires: Date.now() + 60_000,
          }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteFn).not.toHaveBeenCalled();
    });
  });

  it("advises on a version below the first-known floor without declaring it unsupported", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            pluginId: "anthropic",
            config: { command: "claude" },
            liveSessionRequirement: {
              capability: "msg_lifecycle_v1",
              minimumVersion: "2.1.206",
              versionArgs: ["--version"],
              updateCommand: "claude update",
            },
          },
        ],
      });
      const noteFn = vi.fn();

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: "claude-cli/claude-sonnet-4-6" },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          store: createStore(),
          readClaudeCliCredentials: () => ({ type: "api_key_helper" }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
          resolveCommandVersion: () => "2.1.205 (Claude Code)",
        },
      );

      expect(noteBody(noteFn)).toContain(
        "Binary version advisory: Claude Code 2.1.206 is the first published build known to advertise msg_lifecycle_v1; found 2.1.205. OpenClaw verifies this capability at runtime. If this build is rejected, run `claude update`, restart OpenClaw, and retry.",
      );
    });
  });

  it("stays quiet for a healthy non-default Claude CLI runtime agent", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const root = path.dirname(workspaceDir);
      const defaultWorkspace = path.join(root, "workspace-coder");
      const claudeWorkspace = path.join(root, "workspace-xiaoao");
      fs.mkdirSync(defaultWorkspace, { recursive: true });
      fs.mkdirSync(claudeWorkspace, { recursive: true });
      const projectDir = resolveClaudeCliProjectDirForWorkspace({
        workspaceDir: claudeWorkspace,
        homeDir,
      });
      fs.mkdirSync(projectDir, { recursive: true });

      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
            },
            list: [
              {
                id: "coder",
                default: true,
                workspace: defaultWorkspace,
              },
              {
                id: "xiaoao",
                workspace: claudeWorkspace,
                model: "anthropic/claude-opus-4-7",
                models: {
                  "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
                },
              },
            ],
          },
        },
        {
          homeDir,
          noteFn,
          store: createStore({
            [CLAUDE_CLI_PROFILE_ID]: {
              type: "oauth",
              provider: "claude-cli",
              access: "test-auth-token",
              refresh: "test-token-placeholder",
              expires: Date.now() + 60_000,
            },
          }),
          readClaudeCliCredentials: () => ({
            type: "oauth",
            expires: Date.now() + 60_000,
          }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteFn).not.toHaveBeenCalled();
    });
  });

  it("explains the exact bad wiring when the claude-cli auth profile is missing", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          store: createStore(),
          readClaudeCliCredentials: () => ({
            type: "oauth",
            expires: Date.now() + 60_000,
          }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      const body = noteBody(noteFn);
      expect(body).toContain(`OpenClaw auth profile: missing (${CLAUDE_CLI_PROFILE_ID})`);
      expect(body).toContain(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      );
      expect(body).not.toContain("Headless Claude auth: OK");
      expect(body).not.toContain("not created yet");
    });
  });

  it("accepts Claude CLI apiKeyHelper without a stored auth profile", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          store: createStore(),
          readClaudeCliCredentials: () => ({
            type: "api_key_helper",
          }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteFn).not.toHaveBeenCalled();
    });
  });

  it.skipIf(process.platform === "win32")(
    "reports an inaccessible Claude project directory instead of silently treating it as missing",
    async () => {
      if (process.getuid?.() === 0) {
        return;
      }
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        fs.mkdirSync(projectDir, { recursive: true });
        const projectsDir = path.dirname(projectDir);
        fs.chmodSync(projectsDir, 0o000);

        try {
          expect(() => fs.statSync(projectDir)).toThrow(
            expect.objectContaining({ code: "EACCES" }),
          );

          const noteFn = noteHealthyClaudeCliDirectories({ homeDir, workspaceDir });
          expect(noteFn).toHaveBeenCalledOnce();
          expect(noteBody(noteFn)).toContain("Claude project dir:");
          expect(noteBody(noteFn)).toContain("is not readable by this user.");
          expect(noteBody(noteFn)).toContain("- Fix: make the Claude project dir readable");
        } finally {
          fs.chmodSync(projectsDir, 0o755);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "provides actionable repair guidance for a read-only Claude project directory",
    async () => {
      if (process.getuid?.() === 0) {
        return;
      }
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        fs.mkdirSync(projectDir, { recursive: true });
        fs.chmodSync(projectDir, 0o555);

        try {
          const noteFn = noteHealthyClaudeCliDirectories({ homeDir, workspaceDir });
          expect(noteFn).toHaveBeenCalledOnce();
          expect(noteBody(noteFn)).toContain("is not writable by this user.");
          expect(noteBody(noteFn)).toContain("- Fix: make the Claude project dir writable");
        } finally {
          fs.chmodSync(projectDir, 0o755);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports a non-directory Claude project ancestor instead of silently treating it as missing",
    async () => {
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const projectsDir = path.dirname(projectDir);
        fs.mkdirSync(path.dirname(projectsDir), { recursive: true });
        fs.writeFileSync(projectsDir, "not a directory");

        expect(() => fs.statSync(projectDir)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));

        const noteFn = noteHealthyClaudeCliDirectories({ homeDir, workspaceDir });
        expect(noteFn).toHaveBeenCalledOnce();
        expect(noteBody(noteFn)).toContain("Claude project dir:");
        expect(noteBody(noteFn)).toContain("exists but is not a directory.");
        expect(noteBody(noteFn)).toContain("- Fix: make the Claude project dir readable");
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["project", "workspace"] as const)(
    "reports a dangling %s directory symlink instead of silently treating it as missing",
    async (location) => {
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const linkPath = location === "project" ? projectDir : workspaceDir;
        if (location === "project") {
          fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        } else {
          fs.rmdirSync(linkPath);
        }
        fs.symlinkSync(path.join(path.dirname(linkPath), "missing-claude-directory"), linkPath);

        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(() => fs.statSync(linkPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));

        const noteFn = noteHealthyClaudeCliDirectories({ homeDir, workspaceDir });
        expect(noteFn).toHaveBeenCalledOnce();
        expect(noteBody(noteFn)).toContain(
          location === "project" ? "Claude project dir:" : "Workspace:",
        );
        expect(noteBody(noteFn)).toContain("exists but is not a directory.");
        expect(noteBody(noteFn)).toContain("- Fix:");
        if (location === "project") {
          expect(noteBody(noteFn)).toContain("remove the broken path");
        }
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["project", "workspace"] as const)(
    "reports a dangling %s directory ancestor symlink instead of silently treating it as missing",
    async (location) => {
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const ancestorPath =
          location === "project"
            ? path.dirname(projectDir)
            : path.join(path.dirname(workspaceDir), "workspace-parent");
        fs.mkdirSync(path.dirname(ancestorPath), { recursive: true });
        fs.symlinkSync(path.join(homeDir, `missing-${location}-parent-target`), ancestorPath);
        const checkedPath =
          location === "project" ? projectDir : path.join(ancestorPath, "workspace");

        expect(fs.lstatSync(ancestorPath).isSymbolicLink()).toBe(true);
        expect(() => fs.lstatSync(checkedPath)).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );

        const noteFn = noteHealthyClaudeCliDirectories({
          homeDir,
          workspaceDir: location === "project" ? workspaceDir : checkedPath,
        });
        expect(noteFn).toHaveBeenCalledOnce();
        expect(noteBody(noteFn)).toContain(
          location === "project" ? "Claude project dir:" : "Workspace:",
        );
        expect(noteBody(noteFn)).toContain("exists but is not a directory.");
        expect(noteBody(noteFn)).toContain("- Fix:");
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["project", "workspace"] as const)(
    "preserves a healthy %s directory symlink",
    async (location) => {
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const linkPath = location === "project" ? projectDir : workspaceDir;
        if (location === "project") {
          fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        } else {
          fs.rmdirSync(linkPath);
        }
        const targetPath = path.join(homeDir, `healthy-${location}-target`);
        fs.mkdirSync(targetPath, { recursive: true });
        fs.symlinkSync(targetPath, linkPath);

        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(noteHealthyClaudeCliDirectories({ homeDir, workspaceDir })).not.toHaveBeenCalled();
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["project", "workspace"] as const)(
    "preserves a healthy %s directory ancestor symlink",
    async (location) => {
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const ancestorPath =
          location === "project"
            ? path.dirname(projectDir)
            : path.join(path.dirname(workspaceDir), "workspace-parent");
        fs.mkdirSync(path.dirname(ancestorPath), { recursive: true });
        const targetPath = path.join(homeDir, `healthy-${location}-parent-target`);
        fs.mkdirSync(targetPath, { recursive: true });
        fs.symlinkSync(targetPath, ancestorPath);
        const checkedPath =
          location === "project" ? projectDir : path.join(ancestorPath, "workspace");
        expect(fs.lstatSync(ancestorPath).isSymbolicLink()).toBe(true);
        expect(
          noteHealthyClaudeCliDirectories({
            homeDir,
            workspaceDir: location === "project" ? workspaceDir : checkedPath,
          }),
        ).not.toHaveBeenCalled();

        fs.mkdirSync(checkedPath, { recursive: true });
        expect(
          noteHealthyClaudeCliDirectories({
            homeDir,
            workspaceDir: location === "project" ? workspaceDir : checkedPath,
          }),
        ).not.toHaveBeenCalled();
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["project", "workspace"] as const)(
    "reports an unsearchable %s directory even when it is readable and writable",
    async (location) => {
      if (process.getuid?.() === 0) {
        return;
      }
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const dirPath = location === "project" ? projectDir : workspaceDir;
        fs.mkdirSync(dirPath, { recursive: true });
        fs.chmodSync(dirPath, 0o666);

        try {
          expect(() => fs.accessSync(dirPath, fs.constants.R_OK)).not.toThrow();
          expect(() => fs.accessSync(dirPath, fs.constants.W_OK)).not.toThrow();
          expect(() => fs.accessSync(dirPath, fs.constants.X_OK)).toThrow(
            expect.objectContaining({ code: "EACCES" }),
          );

          const noteFn = noteHealthyClaudeCliDirectories({ homeDir, workspaceDir });
          expect(noteFn).toHaveBeenCalledOnce();
          expect(noteBody(noteFn)).toContain(
            location === "project" ? "Claude project dir:" : "Workspace:",
          );
          expect(noteBody(noteFn)).toContain("is not readable by this user.");
          expect(noteBody(noteFn)).toContain("- Fix:");
        } finally {
          fs.chmodSync(dirPath, 0o755);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32").each([
    { location: "project", parentKind: "direct" },
    { location: "project", parentKind: "symlinked" },
    { location: "workspace", parentKind: "direct" },
    { location: "workspace", parentKind: "symlinked" },
  ] as const)(
    "reports a missing $location directory under a $parentKind read-only parent",
    async ({ location, parentKind }) => {
      if (process.getuid?.() === 0) {
        return;
      }
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const parentPath =
          location === "project"
            ? path.dirname(projectDir)
            : path.join(path.dirname(workspaceDir), "read-only-workspace-parent");
        fs.mkdirSync(path.dirname(parentPath), { recursive: true });
        const parentTarget =
          parentKind === "symlinked"
            ? path.join(homeDir, `read-only-${location}-parent-target`)
            : parentPath;
        fs.mkdirSync(parentTarget, { recursive: true });
        if (parentKind === "symlinked") {
          fs.symlinkSync(parentTarget, parentPath);
        }
        const checkedPath =
          location === "project" ? projectDir : path.join(parentPath, "workspace");
        fs.chmodSync(parentTarget, 0o555);

        try {
          expect(() => fs.statSync(checkedPath)).toThrow(
            expect.objectContaining({ code: "ENOENT" }),
          );
          expect(() => fs.mkdirSync(checkedPath)).toThrow(
            expect.objectContaining({ code: "EACCES" }),
          );

          const noteFn = noteHealthyClaudeCliDirectories({
            homeDir,
            workspaceDir: location === "project" ? workspaceDir : checkedPath,
          });
          expect(noteFn).toHaveBeenCalledOnce();
          expect(noteBody(noteFn)).toContain(
            location === "project" ? "Claude project dir:" : "Workspace:",
          );
          expect(noteBody(noteFn)).toContain("is not writable by this user.");
          expect(noteBody(noteFn)).toContain("- Fix:");
        } finally {
          fs.chmodSync(parentTarget, 0o755);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["project", "workspace"] as const)(
    "keeps a missing %s directory quiet when its parent is writable and searchable but unreadable",
    async (location) => {
      if (process.getuid?.() === 0) {
        return;
      }
      await withTempHome(({ homeDir, workspaceDir }) => {
        const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
        const parentPath =
          location === "project"
            ? path.dirname(projectDir)
            : path.join(path.dirname(workspaceDir), "write-only-workspace-parent");
        fs.mkdirSync(parentPath, { recursive: true });
        const checkedPath =
          location === "project" ? projectDir : path.join(parentPath, "workspace");
        fs.chmodSync(parentPath, 0o300);

        try {
          expect(() => fs.accessSync(parentPath, fs.constants.R_OK)).toThrow(
            expect.objectContaining({ code: "EACCES" }),
          );
          expect(() =>
            fs.accessSync(parentPath, fs.constants.W_OK | fs.constants.X_OK),
          ).not.toThrow();
          expect(
            noteHealthyClaudeCliDirectories({
              homeDir,
              workspaceDir: location === "project" ? workspaceDir : checkedPath,
            }),
          ).not.toHaveBeenCalled();
          expect(() => fs.mkdirSync(checkedPath)).not.toThrow();
        } finally {
          fs.chmodSync(parentPath, 0o755);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves actionable repair guidance for a read-only workspace",
    async () => {
      if (process.getuid?.() === 0) {
        return;
      }
      await withTempHome(({ homeDir, workspaceDir }) => {
        fs.chmodSync(workspaceDir, 0o555);

        try {
          const noteFn = noteHealthyClaudeCliDirectories({ homeDir, workspaceDir });
          expect(noteBody(noteFn)).toContain("Workspace:");
          expect(noteBody(noteFn)).toContain("is not writable by this user.");
          expect(noteBody(noteFn)).toContain(
            "- Fix: make the workspace a readable, writable directory for the gateway user.",
          );
        } finally {
          fs.chmodSync(workspaceDir, 0o755);
        }
      });
    },
  );

  it("preserves actionable repair guidance for a non-directory Claude project path", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
      fs.mkdirSync(path.dirname(projectDir), { recursive: true });
      fs.writeFileSync(projectDir, "not a directory");

      const noteFn = noteHealthyClaudeCliDirectories({ homeDir, workspaceDir });
      expect(noteBody(noteFn)).toContain("exists but is not a directory.");
      expect(noteBody(noteFn)).toContain("- Fix: make the Claude project dir readable");
    });
  });

  it("warns when Claude auth is not readable headlessly", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          store: createStore(),
          readClaudeCliCredentials: () => null,
          resolveCommandPath: () => undefined,
        },
      );

      const body = noteBody(noteFn);
      expect(body).toContain('Binary: command "claude" was not found on PATH.');
      expect(body).toContain("Headless Claude auth: unavailable without interactive prompting.");
      expect(body).toContain("claude auth login");
    });
  });

  it("lists Claude CLI agents only when a problem is reported", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const root = path.dirname(workspaceDir);
      const alphaWorkspace = path.join(root, "workspace-alpha");
      const zetaWorkspace = path.join(root, "workspace-zeta");
      fs.writeFileSync(alphaWorkspace, "not a directory");
      fs.mkdirSync(zetaWorkspace, { recursive: true });
      const runtimeModel = "anthropic/claude-opus-4-7";
      const noteFn = vi.fn();

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: { primary: runtimeModel } },
            list: [
              {
                id: "zeta",
                default: true,
                workspace: zetaWorkspace,
                model: runtimeModel,
                models: { [runtimeModel]: { agentRuntime: { id: "claude-cli" } } },
              },
              {
                id: "alpha",
                workspace: alphaWorkspace,
                model: runtimeModel,
                models: { [runtimeModel]: { agentRuntime: { id: "claude-cli" } } },
              },
            ],
          },
        },
        {
          homeDir,
          noteFn,
          store: createStore({
            [CLAUDE_CLI_PROFILE_ID]: {
              type: "oauth",
              provider: "claude-cli",
              access: "test-auth-token",
              refresh: "test-token-placeholder",
              expires: Date.now() + 60_000,
            },
          }),
          readClaudeCliCredentials: () => ({
            type: "oauth",
            expires: Date.now() + 60_000,
          }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteTitle(noteFn)).toBe("Claude CLI");
      const body = noteBody(noteFn);
      expect(body).toContain(
        `Agent alpha workspace: ${alphaWorkspace} exists but is not a directory.`,
      );
      expect(body).toContain("Agents using Claude CLI: alpha, zeta.");
      expect(body).not.toContain(`Agent zeta workspace: ${zetaWorkspace}`);
    });
  });
});
