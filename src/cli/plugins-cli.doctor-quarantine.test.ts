// Plugins doctor tests cover runtime context-engine quarantine reporting.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureContextEnginesInitialized } from "../context-engine/init.js";
import { registerContextEngineForOwner, resolveContextEngine } from "../context-engine/registry.js";
import {
  captureContextEngineRegistryStateForTests,
  resetContextEngineRuntimeQuarantineForTests,
} from "../context-engine/registry.test-support.js";
import {
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeLogs,
} from "./plugins-cli-test-helpers.js";

const ENGINE_ID = "lossless-claw";
const BOOTSTRAP_ERROR = "ENOENT: no such file or directory, stat 'agent:main:main'";

// Drives the shipped quarantine path: a plugin-owned engine is selected, its
// bootstrap throws, and the registry quarantines it and falls back to legacy.
async function quarantineSelectedContextEngine(): Promise<void> {
  registerContextEngineForOwner(
    ENGINE_ID,
    () => ({
      info: { id: "lcm", name: "Lossless Context Manager" },
      async bootstrap() {
        throw new Error(BOOTSTRAP_ERROR);
      },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }: { messages: AgentMessage[] }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    }),
    `plugin:${ENGINE_ID}`,
    { allowSameOwnerRefresh: true },
  );

  const engine = await resolveContextEngine({
    plugins: { slots: { contextEngine: ENGINE_ID } },
  });
  const result = await engine.bootstrap?.({
    sessionId: "main",
    sessionKey: "agent:main:main",
    sessionFile: "/tmp/openclaw-sessions/main.jsonl",
  });

  expect(result?.bootstrapped).toBe(false);
  expect(engine.info.id).toBe("legacy");
}

let restoreContextEngineRegistry = () => {};

beforeAll(() => {
  restoreContextEngineRegistry = captureContextEngineRegistryStateForTests();
  // Registers the built-in legacy engine exactly as runtime startup does, so the
  // quarantine fallback resolves the same engine operators end up running on.
  ensureContextEnginesInitialized();
});

afterAll(() => {
  restoreContextEngineRegistry();
});

describe("plugins doctor runtime quarantines", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    resetContextEngineRuntimeQuarantineForTests();
  });

  it("reports a quarantined context engine instead of a clean bill of health", async () => {
    await quarantineSelectedContextEngine();

    await runPluginsCommand(["plugins", "doctor"]);

    const output = runtimeLogs.join("\n");
    expect(output).not.toContain("No plugin issues detected.");
    expect(output).toContain(`context engine "${ENGINE_ID}"`);
    expect(output).toContain(`plugin:${ENGINE_ID}`);
    expect(output).toContain(BOOTSTRAP_ERROR);
    expect(output).toContain("legacy");
  });

  it("still reports a clean bill of health when nothing is quarantined", async () => {
    await runPluginsCommand(["plugins", "doctor"]);

    expect(runtimeLogs).toContain("No plugin issues detected.");
  });
});
