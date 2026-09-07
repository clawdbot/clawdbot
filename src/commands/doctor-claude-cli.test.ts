// Doctor Claude CLI tests cover CLI discovery, version checks, and repair guidance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { noteClaudeCliHealth } from "./doctor-claude-cli.js";

const resolveCliBackendConfigMock = vi.hoisted(() => vi.fn());
const resolveModelAgentRuntimeMetadataMock = vi.hoisted(() =>
  vi.fn((_params: { agentId: string }) => ({ id: "openclaw", source: "implicit" })),
);

vi.mock("../agents/cli-backends.js", () => ({
  resolveCliBackendConfig: resolveCliBackendConfigMock,
}));

vi.mock("../agents/agent-runtime-metadata.js", () => ({
  resolveModelAgentRuntimeMetadata: resolveModelAgentRuntimeMetadataMock,
}));

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

function noteBody(noteFn: ReturnType<typeof vi.fn>): string {
  const value = expectDefined<unknown[]>(noteFn.mock.calls[0], "note call").at(0);
  if (typeof value !== "string") {
    throw new Error("Expected note body");
  }
  return value;
}

function noteTitle(noteFn: ReturnType<typeof vi.fn>): string {
  const value = expectDefined<unknown[]>(noteFn.mock.calls[0], "note call").at(1);
  if (typeof value !== "string") {
    throw new Error("Expected note title");
  }
  return value;
}

describe("noteClaudeCliHealth", () => {
  afterEach(() => {
    resolveCliBackendConfigMock.mockReset();
    resolveModelAgentRuntimeMetadataMock
      .mockReset()
      .mockReturnValue({ id: "openclaw", source: "implicit" });
    vi.restoreAllMocks();
  });

  it("probes the executable resolved by the owning backend", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveCliBackendConfigMock.mockReturnValue({
        id: "claude-cli",
        pluginId: "custom-anthropic",
        config: { command: "/opt/custom/bin/claude" },
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
          isAuthenticated: () => true,
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteFn).not.toHaveBeenCalled();
    });
  });

  it("probes auth with the same cleared environment as Claude execution", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveCliBackendConfigMock.mockReturnValue({
        id: "claude-cli",
        pluginId: "anthropic",
        config: {
          command: "claude",
          clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        },
      });
      const isAuthenticated = vi.fn(() => true);

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: "claude-cli/claude-sonnet-4-6" },
            entries: { main: { default: true } },
          },
        },
        {
          env: {
            ANTHROPIC_API_KEY: "ambient-api-key",
            CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth-token",
            CLAUDE_CONFIG_DIR: "/tmp/claude-config",
            PATH: "/usr/bin",
          },
          homeDir,
          workspaceDir,
          isAuthenticated,
          noteFn: vi.fn(),
          resolveCommandPath: () => "/usr/bin/claude",
        },
      );

      expect(isAuthenticated).toHaveBeenCalledWith("/usr/bin/claude", {
        CLAUDE_CONFIG_DIR: "/tmp/claude-config",
        PATH: "/usr/bin",
      });
    });
  });

  it("stays quiet for a healthy non-default Claude CLI runtime agent", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveModelAgentRuntimeMetadataMock.mockImplementation(({ agentId }) => ({
        id: agentId === "xiaoao" ? "claude-cli" : "openclaw",
        source: agentId === "xiaoao" ? "model" : "implicit",
      }));
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
          isAuthenticated: () => true,
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteFn).not.toHaveBeenCalled();
    });
  });

  it("reports when Claude CLI owns no active login", async () => {
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
          isAuthenticated: () => false,
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      const body = noteBody(noteFn);
      expect(body).toContain("Claude auth: not logged in.");
      expect(body).toContain("claude auth login");
      expect(body).not.toContain("openclaw models auth login");
    });
  });

  it("warns when the Claude binary is missing", async () => {
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
          resolveCommandPath: () => undefined,
        },
      );

      const body = noteBody(noteFn);
      expect(body).toContain('Binary: command "claude" was not found on PATH.');
      expect(body).not.toContain("claude auth login");
    });
  });

  it("lists Claude CLI agents only when a problem is reported", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveModelAgentRuntimeMetadataMock.mockReturnValue({
        id: "claude-cli",
        source: "model",
      });
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
          isAuthenticated: () => true,
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
