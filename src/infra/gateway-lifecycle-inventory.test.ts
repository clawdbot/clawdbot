import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGatewayActiveWorkSnapshot } from "./gateway-active-work.js";

const ARXI_LIFECYCLE_REVIEWED_UPSTREAM_COMMIT = "4e7bf407d19bc96d1e95d48b562d1960de68511d";

const GATEWAY_LIFECYCLE_ACTIVE_PRODUCERS = [
  { id: "command-queue", countKey: "queueSize" },
  { id: "reply-dispatch", countKey: "pendingReplies" },
  { id: "embedded-agent-run", countKey: "embeddedRuns" },
  { id: "background-exec", countKey: "backgroundExecSessions" },
  { id: "cron-run-and-watchers", countKey: "cronRuns" },
  { id: "task-registry", countKey: "activeTasks" },
  { id: "gateway-root-request", countKey: "rootRequests" },
  { id: "session-work-admission", countKey: "sessionAdmissions" },
  { id: "session-lifecycle-mutation", countKey: "sessionMutations" },
  { id: "chat-run", countKey: "chatRuns" },
  { id: "queued-chat-turn", countKey: "queuedTurns" },
  { id: "terminal-persistence", countKey: "terminalPersistence" },
  { id: "terminal-session", countKey: "terminalSessions" },
] as const;

const GATEWAY_LIFECYCLE_TIME_BASED_PRODUCERS = [
  { id: "cron", wakeSource: "CronService.getSuspendWakeSnapshot" },
] as const;

describe("Arxi lifecycle upgrade inventory", () => {
  it("covers every canonical active-work count", () => {
    const countKeys = Object.keys(createGatewayActiveWorkSnapshot().counts)
      .filter((key) => key !== "totalActive")
      .toSorted();
    const inventoried = GATEWAY_LIFECYCLE_ACTIVE_PRODUCERS.map(
      (entry) => entry.countKey,
    ).toSorted();
    expect(inventoried).toEqual(countKeys);
  });

  it("keeps every reviewed time producer in the wake contract", () => {
    expect(GATEWAY_LIFECYCLE_TIME_BASED_PRODUCERS).toEqual([
      { id: "cron", wakeSource: "CronService.getSuspendWakeSnapshot" },
    ]);
  });

  it("fails an upstream upgrade until the producer inventory is reviewed", () => {
    const reviewedParents = execFileSync(
      "git",
      ["log", "--first-parent", "--merges", "--grep=Merge pinned upstream", "--format=%P", "-1"],
      { encoding: "utf8" },
    ).trim();
    const reviewedUpstreamCommit = reviewedParents.split(/\s+/u)[1];
    expect(reviewedUpstreamCommit).toBe(ARXI_LIFECYCLE_REVIEWED_UPSTREAM_COMMIT);
  });
});
