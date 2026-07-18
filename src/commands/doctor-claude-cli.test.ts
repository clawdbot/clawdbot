// Doctor Claude CLI tests cover CLI discovery, version checks, and repair guidance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
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
    vi.restoreAllMocks();
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

  it("warns when Claude auth is not readable headlessly", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
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
