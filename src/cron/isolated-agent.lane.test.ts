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

function lastEmbeddedLane(): string | undefined {
  const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls.at(-1)?.[0] as { lane?: string } | undefined)?.lane;
}

async function runLaneCase(home: string, lane?: string) {
  const storePath = await writeSessionStoreEntries(home, {
    "agent:main:main": {
      sessionId: "main-session",
      updatedAt: Date.now(),
      lastProvider: "webchat",
      lastTo: "",
    },
  });
  mockAgentPayloads([{ text: "ok" }]);

  await runCronIsolatedAgentTurn({
    cfg: makeCfg(home, storePath),
    deps: createCliDeps(),
    job: { ...makeJob({ kind: "agentTurn", message: "do it" }), delivery: { mode: "none" } },
    message: "do it",
    sessionKey: "cron:job-1",
    ...(lane === undefined ? {} : { lane }),
  });

  return lastEmbeddedLane();
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

describe("runCronIsolatedAgentTurn lane selection", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
  });

  afterEach(() => {
    // Shared-worker runs can start collecting the next file before the generic
    // runner cleanup resets env and session-store globals.
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

  it("moves the cron lane to cron-nested for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      expect(await runLaneCase(home, "cron")).toBe("cron-nested");
    });
  });

  it("defaults missing lanes to cron-nested for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      expect(await runLaneCase(home)).toBe("cron-nested");
    });
  });

  it("preserves non-cron lanes for embedded runs", async () => {
    await withTempCronHome(async (home) => {
      expect(await runLaneCase(home, "subagent")).toBe("subagent");
    });
  });
});
