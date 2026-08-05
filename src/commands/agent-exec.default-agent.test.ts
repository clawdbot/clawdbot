import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand } from "./agent-exec.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function successResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: text,
      agentMeta: { sessionId: "session-result", provider: "openai", model: "gpt-5.6-sol" },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("agent exec default agent scoping", () => {
  // Regression: exec left `agentId` unset, so the session key it built
  // normalized to the legacy `main` lane while the SQLite store target
  // resolved ownership through the configured default agent, and any
  // non-`main` default threw before the model was ever reached.
  it("resolves a store scope that does not throw when the default agent is not main", async () => {
    const configPath = path.join(
      await makeTempRoot("openclaw-agent-exec-default-agent-"),
      "openclaw.json",
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { entries: { alpha: { default: true } } } }),
    );
    const runAgent = vi.fn(async () => successResult());

    const result = await agentExecCommand("inspect", { config: configPath }, createRuntime(), {
      runAgent,
    });

    expect(result.exitCode).toBe(0);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "alpha" }),
      expect.any(Object),
    );
  });
});
