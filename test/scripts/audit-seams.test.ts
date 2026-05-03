import { describe, expect, it } from "vitest";
import {
  HELP_TEXT,
  describeSeamKinds,
  determineSeamTestStatus,
} from "../../scripts/audit-seams.mjs";

describe("audit-seams cron seam classification", () => {
  it("detects cron agent handoff and outbound delivery boundaries", () => {
    const source = `
      import { runCliAgent } from "../../agents/cli-runner.js";
      import { runWithModelFallback } from "../../agents/model-fallback.js";
      import { registerAgentRunContext } from "../../infra/agent-events.js";
      import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
      import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";

      export async function runCronIsolatedAgentTurn() {
        registerAgentRunContext({});
        await runWithModelFallback(() => runCliAgent({}));
        await deliverOutboundPayloads({ payloads: [{ text: "done" }] });
        return buildOutboundSessionContext({});
      }
    `;

    expect(describeSeamKinds("src/cron/isolated-agent/run.ts", source)).toEqual([
      "cron-agent-handoff",
      "cron-outbound-delivery",
    ]);
  });

  it("detects scheduler-state seams in cron service orchestration", () => {
    const source = `
      import { recomputeNextRuns, computeJobNextRunAtMs } from "./jobs.js";
      import { ensureLoaded, persist } from "./store.js";
      import { armTimer, runMissedJobs } from "./timer.js";

      export async function start(state) {
        await ensureLoaded(state);
        recomputeNextRuns(state);
        await persist(state);
        armTimer(state);
        await runMissedJobs(state);
        return computeJobNextRunAtMs(state.store.jobs[0], Date.now());
      }
    `;

    expect(describeSeamKinds("src/cron/service/ops.ts", source)).toContain("cron-scheduler-state");
  });
});

describe("audit-seams subagent seam classification", () => {
  it("detects subagent spawn and cleanup handoff boundaries", () => {
    const source = `
      import { callGateway } from "../gateway/call.js";
      import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
      import { registerSubagentRun } from "./subagent-registry.js";

      export async function spawnSubagentDirect() {
        const response = await callGateway({ method: "agent.run", params: { task: "do it" } });
        registerSubagentRun({ childSessionKey: "agent:main:subagent:child" });
        await callGateway({ method: "sessions.delete", params: { key: "agent:main:subagent:child" } });
        emitSessionLifecycleEvent({ sessionKey: "agent:main:subagent:child", type: "spawned" });
        return response;
      }
    `;

    expect(describeSeamKinds("src/agents/subagent-spawn.ts", source)).toEqual([
      "subagent-lifecycle-registry",
      "subagent-session-cleanup",
      "subagent-session-spawn",
    ]);
  });

  it("detects subagent lifecycle registry and announce delivery seams", () => {
    const source = `
      import { resolveContextEngine } from "../context-engine/registry.js";
      import { captureSubagentCompletionReply, runSubagentAnnounceFlow } from "./subagent-announce.js";
      import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";
      import { persistSubagentRunsToDisk } from "./subagent-registry-state.js";

      export async function completeRun(entry) {
        await resolveContextEngine({});
        await captureSubagentCompletionReply(entry.childSessionKey);
        await emitSubagentEndedHookOnce({ runId: entry.runId });
        persistSubagentRunsToDisk(new Map());
        return runSubagentAnnounceFlow({ childSessionKey: entry.childSessionKey });
      }
    `;

    expect(describeSeamKinds("src/agents/subagent-registry.ts", source)).toEqual([
      "subagent-announce-delivery",
      "subagent-lifecycle-registry",
    ]);
  });

  it("detects parent-stream seams for ACP spawn relays", () => {
    const source = `
      import { onAgentEvent } from "../infra/agent-events.js";
      import { requestHeartbeat } from "../infra/heartbeat-wake.js";
      import { enqueueSystemEvent } from "../infra/system-events.js";

      export function startAcpSpawnParentStreamRelay() {
        onAgentEvent("agent-output", () => {});
        requestHeartbeat({
          source: "acp-spawn",
          intent: "event",
          reason: "acp:spawn:stream",
          sessionKey: "agent:main",
        });
        enqueueSystemEvent("progress", { sessionKey: "agent:main", contextKey: "stream" });
        return { streamTo: "parent" };
      }
    `;

    expect(describeSeamKinds("src/agents/acp-spawn-parent-stream.ts", source)).toEqual([
      "subagent-parent-stream",
    ]);
  });
});

describe("audit-seams status/help", () => {
  it("keeps cron seam statuses conservative when nearby tests exist", () => {
    expect(
      determineSeamTestStatus(
        ["cron-agent-handoff"],
        [{ file: "src/cron/service.issue-regressions.test.ts", matchQuality: "path-nearby" }],
      ),
    ).toEqual({
      status: "partial",
      reason:
        "Nearby tests exist (best match: path-nearby), but this inventory does not prove cross-layer seam coverage end to end.",
    });
  });

  it("keeps subagent seam statuses conservative when nearby tests exist", () => {
    expect(
      determineSeamTestStatus(
        ["subagent-session-spawn"],
        [{ file: "src/agents/subagent-spawn.workspace.test.ts", matchQuality: "direct-import" }],
      ),
    ).toEqual({
      status: "partial",
      reason:
        "Nearby tests exist (best match: direct-import), but this inventory does not prove cross-layer seam coverage end to end.",
    });
  });

  it("documents cron and subagent seam coverage in help text", () => {
    expect(HELP_TEXT).toContain("cron orchestration seams");
    expect(HELP_TEXT).toContain("subagent seams");
    expect(HELP_TEXT).toContain("announce delivery");
    expect(HELP_TEXT).toContain("parent streaming");
  });
});
