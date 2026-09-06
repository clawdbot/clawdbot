import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand } from "./agent-exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent exec owner selection", () => {
  it.each([
    {
      name: "a migrated legacy default",
      config: {
        agents: {
          entries: {
            alpha: { default: true },
            beta: {},
          },
        },
      },
    },
    {
      name: "the canonical system-agent owner",
      config: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "alpha" } },
          entries: { alpha: {}, beta: {} },
        },
      },
    },
  ])("uses $name for the run and its SQLite store scope", async ({ config }) => {
    const configRoot = tempDirs.make("openclaw-agent-exec-default-agent-");
    const configPath = path.join(configRoot, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const runAgent = vi.fn(async (options: Record<string, unknown>) => {
      const requestedAgentId = typeof options.agentId === "string" ? options.agentId : "main";
      const sessionId = String(options.sessionId);
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "alpha",
        env: process.env,
      });

      // Exercise the production guard that rejects keys owned by another agent.
      expect(() =>
        resolveSqliteScope({
          agentId: requestedAgentId,
          defaultAgentId: "alpha",
          env: process.env,
          sessionKey: `agent:${requestedAgentId}:explicit:${sessionId}`,
          storePath,
        }),
      ).not.toThrow();
      expect(requestedAgentId).toBe("alpha");
      return {
        payloads: [{ text: "done" }],
        meta: { durationMs: 1 },
      };
    });

    const result = await agentExecCommand("inspect", { config: configPath }, runtime, { runAgent });

    expect(result.envelope.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(runAgent).toHaveBeenCalledOnce();
  });
});
