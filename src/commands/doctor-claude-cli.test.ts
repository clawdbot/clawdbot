import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  noteClaudeCliHealth,
  resolveClaudeCliProjectDirForWorkspace,
} from "./doctor-claude-cli.js";

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

  it("reports a healthy claude-cli setup with the resolved Claude project dir", async () => {
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
              access: "token-a",
              refresh: "token-r",
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

      expect(noteFn).toHaveBeenCalledTimes(1);
      expect(noteFn.mock.calls[0]?.[1]).toBe("Claude CLI");
      const body = String(noteFn.mock.calls[0]?.[0]);
      expect(body).toContain("Binary: /opt/homebrew/bin/claude.");
      expect(body).toContain("Headless Claude auth: OK (oauth).");
      expect(body).toContain(
        `OpenClaw auth profile: ${CLAUDE_CLI_PROFILE_ID} (provider claude-cli).`,
      );
      expect(body).toContain("Workspace:");
      expect(body).toContain("(writable).");
      expect(body).toContain("Claude project dir:");
      expect(body).toContain("(present).");
    });
  });

  it("reports the Claude CLI workspace for a non-default runtime agent", async () => {
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
              agentRuntime: { id: "codex" },
              model: { primary: "openai/gpt-5.5" },
            },
            list: [
              {
                id: "coder",
                default: true,
                workspace: defaultWorkspace,
                agentRuntime: { id: "codex" },
              },
              {
                id: "xiaoao",
                workspace: claudeWorkspace,
                agentRuntime: { id: "claude-cli", fallback: "none" },
                model: "anthropic/claude-opus-4-7",
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
              access: "token-a",
              refresh: "token-r",
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

      expect(noteFn).toHaveBeenCalledTimes(1);
      const body = String(noteFn.mock.calls[0]?.[0]);
      expect(body).toContain(`Agent xiaoao workspace: ${claudeWorkspace} (writable).`);
      expect(body).toContain(`Agent xiaoao Claude project dir: ${projectDir} (present).`);
      expect(body).not.toContain(defaultWorkspace);
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

      const body = String(noteFn.mock.calls[0]?.[0]);
      expect(body).toContain("Headless Claude auth: OK (oauth).");
      expect(body).toContain(`OpenClaw auth profile: missing (${CLAUDE_CLI_PROFILE_ID})`);
      expect(body).toContain(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      );
      expect(body).toContain(
        "not created yet; it appears after the first Claude CLI turn in this workspace",
      );
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

      const body = String(noteFn.mock.calls[0]?.[0]);
      expect(body).toContain('Binary: command "claude" was not found on PATH.');
      expect(body).toContain("Headless Claude auth: unavailable without interactive prompting.");
      expect(body).toContain("claude auth login");
    });
  });
});
