import "./isolated-agent.mocks.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllBootstrapSnapshots } from "../agents/bootstrap-cache.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";

function lastEmbeddedCall(): { runTimeoutOverrideMs?: number; timeoutMs?: number } {
  const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)?.[0] as { runTimeoutOverrideMs?: number; timeoutMs?: number };
}

const envSnapshot = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  OPENCLAW_HOME: process.env.OPENCLAW_HOME,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
} as const;

function restoreSnapshotEnv() {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("runCronIsolatedAgentTurn — explicit per-run timeout signal", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
  });

  afterEach(() => {
    restoreSnapshotEnv();
    vi.doUnmock("../agents/pi-embedded.js");
    vi.doUnmock("../agents/model-catalog.js");
    vi.doUnmock("../agents/model-selection.js");
    vi.doUnmock("../agents/subagent-announce.js");
    vi.doUnmock("../gateway/call.js");
    clearSessionStoreCacheForTest();
    resetAgentRunContextForTest();
    clearAllBootstrapSnapshots();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Regression: when a cron job's payload `timeoutSeconds` numerically equals
  // `agents.defaults.timeoutSeconds`, the run is still an *explicit* per-run
  // override. The embedded runner used to detect "explicit" by comparing
  // `params.timeoutMs !== resolveAgentTimeoutMs({cfg})` — which collapses to
  // `false` in this case, stripping the runTimeoutMs signal and letting the
  // LLM idle watchdog fall back to the implicit 120s cap.
  // Fix: forward `runTimeoutOverrideMs` from the cron entry point so the
  // explicit-vs-default distinction survives the merge into `timeoutMs`.
  it("forwards runTimeoutOverrideMs when payload.timeoutSeconds equals the agent default", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "webchat",
          lastTo: "",
        },
      });
      mockAgentPayloads([{ text: "ok" }]);

      const cfg = makeCfg(home, storePath, {
        agents: { defaults: { timeoutSeconds: 300 } },
      });

      await runCronIsolatedAgentTurn({
        cfg,
        deps: createCliDeps(),
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it", timeoutSeconds: 300 }),
          delivery: { mode: "none" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
      });

      const call = lastEmbeddedCall();
      expect(call.runTimeoutOverrideMs).toBe(300_000);
    });
  });

  it("forwards runTimeoutOverrideMs when payload.timeoutSeconds differs from the agent default", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "webchat",
          lastTo: "",
        },
      });
      mockAgentPayloads([{ text: "ok" }]);

      const cfg = makeCfg(home, storePath, {
        agents: { defaults: { timeoutSeconds: 300 } },
      });

      await runCronIsolatedAgentTurn({
        cfg,
        deps: createCliDeps(),
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it", timeoutSeconds: 600 }),
          delivery: { mode: "none" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
      });

      const call = lastEmbeddedCall();
      expect(call.runTimeoutOverrideMs).toBe(600_000);
    });
  });

  it("leaves runTimeoutOverrideMs undefined when payload omits timeoutSeconds", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "webchat",
          lastTo: "",
        },
      });
      mockAgentPayloads([{ text: "ok" }]);

      const cfg = makeCfg(home, storePath, {
        agents: { defaults: { timeoutSeconds: 300 } },
      });

      await runCronIsolatedAgentTurn({
        cfg,
        deps: createCliDeps(),
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "none" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
      });

      const call = lastEmbeddedCall();
      expect(call.runTimeoutOverrideMs).toBeUndefined();
    });
  });
});
