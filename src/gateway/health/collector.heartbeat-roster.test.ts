import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveHeartbeatSummaryForAgent } from "../../infra/heartbeat-summary.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "./collector.js";

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

const AGENT_COUNT = 200;

/** Fleet with heartbeat defaults and one explicit per-agent override. */
function makeFleetConfig(storePath: string): OpenClawConfig {
  const entries: Record<string, { heartbeat?: { every?: string } }> = {};
  for (let index = 0; index < AGENT_COUNT; index += 1) {
    entries[`agent-${index}`] = {};
  }
  entries["agent-7"] = { heartbeat: { every: "45m" } };
  return {
    agents: {
      ownership: "explicit",
      defaults: { heartbeat: { every: "30m", target: "owner" } },
      entries,
    },
    session: { store: storePath },
  };
}

/** Counts how often the roster is read: every walk starts at `agents.entries`. */
function countRosterReads(cfg: OpenClawConfig): { cfg: OpenClawConfig; reads: () => number } {
  let reads = 0;
  const agents = new Proxy(cfg.agents as object, {
    get(target, property, receiver) {
      if (property === "entries") {
        reads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { cfg: { ...cfg, agents: agents as OpenClawConfig["agents"] }, reads: () => reads };
}

describe("health agent summaries heartbeat roster", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("resolves heartbeat enrollment for the whole fleet without re-walking the roster per agent", async () => {
    // An absent store keeps the read-only session reader empty; only enrollment is under test.
    const storePath = path.join(
      tempDirs.make("openclaw-health-heartbeat-roster-"),
      "sessions.json",
    );
    const plain = makeFleetConfig(storePath);
    const counted = countRosterReads(plain);

    const summaries = await buildHealthAgentSummaries(counted.cfg, resolveHealthAgentOrder(plain));

    expect(summaries).toHaveLength(AGENT_COUNT);
    // Per-agent enrollment walks the roster once per agent (and once more per
    // roster member inside that walk); the fleet must stay far below that.
    expect(counted.reads()).toBeLessThan(AGENT_COUNT);
    expect(summaries.map((summary) => summary.heartbeat)).toEqual(
      summaries.map((summary) => resolveHeartbeatSummaryForAgent(plain, summary.agentId)),
    );
    expect(summaries.find((summary) => summary.agentId === "agent-7")?.heartbeat).toMatchObject({
      enabled: true,
      every: "45m",
    });
  });
});
