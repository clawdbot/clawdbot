import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import {
  writeBundleProbeMcpServer,
  writeClaudeBundle,
  writeFakeClaudeCli,
  writeFakeClaudeLiveCli,
} from "./bundle-mcp.test-harness.js";

vi.mock("./cli-runner/helpers.js", async () => {
  const original =
    await vi.importActual<typeof import("./cli-runner/helpers.js")>("./cli-runner/helpers.js");
  return {
    ...original,
    // This e2e only validates bundle MCP wiring into the spawned CLI backend.
    // Stub the large prompt-construction path so cold Vitest workers do not
    // time out before the actual MCP roundtrip runs.
    buildSystemPrompt: () => "Bundle MCP e2e test prompt.",
  };
});

// This e2e spins a real stdio MCP server plus a spawned CLI process, which is
// notably slower under Docker and cold Vitest imports. The plugins Docker lane
// also reaches this test after several gateway/plugin restart exercises.
const E2E_TIMEOUT_MS = 90_000;

describe("runCliAgent bundle MCP e2e", () => {
  it(
    "routes enabled bundle MCP config into the claude-cli backend and executes the tool",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { runCliAgent } = await import("./cli-runner.js");
      const { resetGlobalHookRunner } = await import("../plugins/hook-runner-global.js");
      const envSnapshot = captureEnv(["HOME"]);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bundle-mcp-"));
      process.env.HOME = tempHome;
      resetGlobalHookRunner();

      const workspaceDir = path.join(tempHome, "workspace");
      const sessionFile = path.join(tempHome, "session.jsonl");
      const binDir = path.join(tempHome, "bin");
      const serverScriptPath = path.join(tempHome, "mcp", "bundle-probe.mjs");
      const fakeClaudePath = path.join(binDir, "fake-claude.mjs");
      const pluginRoot = path.join(tempHome, ".openclaw", "extensions", "bundle-probe");
      await fs.mkdir(workspaceDir, { recursive: true });
      await writeBundleProbeMcpServer(serverScriptPath);
      await writeFakeClaudeCli(fakeClaudePath);
      await writeClaudeBundle({ pluginRoot, serverScriptPath });

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            cliBackends: {
              "claude-cli": {
                command: "node",
                args: [fakeClaudePath],
                clearEnv: [],
              },
            },
          },
        },
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      try {
        const result = await runCliAgent({
          sessionId: "session:test",
          sessionFile,
          workspaceDir,
          config,
          prompt: "Use your configured MCP tools and report the bundle probe text.",
          provider: "claude-cli",
          model: "test-bundle",
          timeoutMs: 20_000,
          runId: "bundle-mcp-e2e",
        });

        expect(result.payloads?.[0]?.text).toContain("BUNDLE MCP OK FROM-BUNDLE");
        expect(result.meta.agentMeta?.sessionId.length ?? 0).toBeGreaterThan(0);
      } finally {
        resetGlobalHookRunner();
        await fs.rm(tempHome, { recursive: true, force: true });
        envSnapshot.restore();
      }
    },
  );

  it(
    "exits one-shot Claude live-session runs and closes the MCP loopback server",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { runCliAgent } = await import("./cli-runner.js");
      const { closeMcpLoopbackServer, getActiveMcpLoopbackRuntime } =
        await import("../gateway/mcp-http.js");
      const { resetGlobalHookRunner } = await import("../plugins/hook-runner-global.js");
      const envSnapshot = captureEnv(["HOME"]);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-live-cleanup-"));
      process.env.HOME = tempHome;
      resetGlobalHookRunner();
      await closeMcpLoopbackServer();

      const workspaceDir = path.join(tempHome, "workspace");
      const sessionFile = path.join(tempHome, "session.jsonl");
      const binDir = path.join(tempHome, "bin");
      const serverScriptPath = path.join(tempHome, "mcp", "bundle-probe.mjs");
      const fakeClaudePath = path.join(binDir, "fake-live-claude.mjs");
      const fakeClaudePidPath = path.join(tempHome, "fake-live-claude.pid");
      const pluginRoot = path.join(tempHome, ".openclaw", "extensions", "bundle-probe");
      await fs.mkdir(workspaceDir, { recursive: true });
      await writeBundleProbeMcpServer(serverScriptPath);
      await writeFakeClaudeLiveCli({ filePath: fakeClaudePath, pidPath: fakeClaudePidPath });
      await writeClaudeBundle({ pluginRoot, serverScriptPath });

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            cliBackends: {
              "claude-cli": {
                command: "node",
                args: [fakeClaudePath],
                clearEnv: [],
                liveSession: "claude-stdio",
              },
            },
          },
        },
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      try {
        const result = await runCliAgent({
          sessionId: "session:test-live-cleanup",
          sessionFile,
          workspaceDir,
          config,
          prompt: "Use your configured MCP tools and report the bundle probe text.",
          provider: "claude-cli",
          model: "test-live-bundle",
          timeoutMs: 20_000,
          runId: "bundle-mcp-live-cleanup-e2e",
          cleanupBundleMcpOnRunEnd: true,
          cleanupCliLiveSessionOnRunEnd: true,
        });

        expect(result.payloads?.[0]?.text).toContain("LIVE BUNDLE MCP OK FROM-BUNDLE");
        expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
        const fakeClaudePid = Number.parseInt(await fs.readFile(fakeClaudePidPath, "utf-8"), 10);
        expect(Number.isFinite(fakeClaudePid)).toBe(true);
        expect(() => process.kill(fakeClaudePid, 0)).toThrow();
      } finally {
        await closeMcpLoopbackServer();
        resetGlobalHookRunner();
        await fs.rm(tempHome, { recursive: true, force: true });
        envSnapshot.restore();
      }
    },
  );
});
