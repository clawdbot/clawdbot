import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  backfillSubagentRequesterAgentIds,
  resolveSubagentRequesterAgentId,
} from "./subagent-requester-owner.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";
import {
  countActiveRunsForSessionFromRuns,
  listRunsForRequesterFromRuns,
} from "./subagents/registry/subagent-registry-queries.js";
import { markRequesterTurnYieldedInRuns } from "./subagents/registry/subagent-registry-requester-yield.js";

describe("resolveSubagentRequesterAgentId", () => {
  it("attributes a legacy bare requester row only to the persisted fixed-store owner", () => {
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(resolveSubagentRequesterAgentId(cfg, { requesterSessionKey: "global" })).toBe("ops");
    expect(
      resolveSubagentRequesterAgentId(cfg, {
        requesterSessionKey: "global",
        requesterAgentId: "research",
      }),
    ).toBe("research");
  });

  it("materializes legacy ownership before requester selectors run", () => {
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    const entry = createSubagentRunRecord({
      runId: "legacy-run",
      childSessionKey: "agent:worker:subagent:legacy",
      controllerSessionKey: "global",
      requesterSessionKey: "global",
      requesterDisplayKey: "global",
      requesterTurnRunId: "requester-turn",
      expectsCompletionMessage: true,
      task: "legacy task",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 2,
    });
    delete entry.requesterAgentId;
    const runs = new Map([[entry.runId, entry]]);

    expect(backfillSubagentRequesterAgentIds(cfg, runs.values())).toBe(1);
    expect(entry.requesterAgentId).toBe("ops");
    expect(listRunsForRequesterFromRuns(runs, "global", { requesterAgentId: "ops" })).toEqual([
      entry,
    ]);
    expect(listRunsForRequesterFromRuns(runs, "global", { requesterAgentId: "research" })).toEqual(
      [],
    );
    expect(countActiveRunsForSessionFromRuns(runs, "global", { requesterAgentId: "ops" })).toBe(1);
    expect(
      markRequesterTurnYieldedInRuns({
        requesterSessionKey: "global",
        requesterAgentId: "ops",
        requesterTurnRunId: "requester-turn",
        runs,
        persistOrThrow: () => undefined,
      }),
    ).toBe(1);
  });
});
