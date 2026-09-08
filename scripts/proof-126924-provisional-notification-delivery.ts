import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
/**
 * Provisional notification delivery proof; run from the checked-out repo:
 * node --import ./scripts/tsx.mjs scripts/proof-126924-provisional-notification-delivery.ts
 *
 * Real: announcement coordinator, direct-delivery classifiers, dispatch, registry
 * singleton and wall-clock retry/grace timers, SQLite session/task/run persistence,
 * and lifecycle event completion. No Vitest, module mocks, or fake timers.
 *
 * Scripted edges: Gateway agent.wait/synthesis responses and channel sends; the
 * empty plugin-host result and browser-resource cleanup edge. Every announcement
 * still executes runSubagentAnnounceFlow; an observational wrapper records its
 * result, never replaces it. Delivery receipts below describe only the local
 * scripted channel edge, not delivery to a live channel. No provider is invoked.
 *
 * The fixture setup follows proof-126924-subagent-wait-expiry-not-death.ts. This
 * narrower proof exercises notification settlement, not process liveness, restart
 * recovery, deletion retention or all registry behavior (covered by that proof).
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentInternalEvent } from "../src/agents/internal-events.js";
import type { SubagentAnnounceDeliveryResult } from "../src/agents/subagents/announce/subagent-announce-dispatch.js";
import type { callGateway } from "../src/gateway/call.js";
import type { sendMessage } from "../src/infra/outbound/message.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provisional-delivery-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });
fs.writeFileSync(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
  }),
);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
async function until(label: string, predicate: () => boolean, budgetMs = 25_000) {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await sleep(50);
  }
}
const heartbeat = new Worker(
  'const fs = require("node:fs"); setInterval(() => fs.writeSync(1, "[alive] provisional delivery proof running\\n"), 5000);',
  { eval: true, execArgv: [] },
);
heartbeat.unref();
const failureNotice =
  "A delegated task failed before it could report a result. Please retry the task.";
const dmOrigin = { channel: "discord", to: "dm:proof-user", accountId: "proof-account" };
const slackOrigin = { channel: "slack", to: "channel:proof", accountId: "proof-account" };
const dmRequester = "agent:main:discord:dm:proof-user";
const slackRequester = "agent:main:slack:channel:proof";
const finalText = "FINAL: this same child completed after notification settlement";
let exitCode = 0;
try {
  const delivery = await import("../src/agents/subagents/announce/subagent-announce-delivery.js");
  const deliveryRuntime =
    await import("../src/agents/subagents/announce/subagent-announce-delivery.runtime.js");
  const announce = await import("../src/agents/subagents/announce/subagent-announce.js");
  const registry = await import("../src/agents/subagents/registry/subagent-registry.js");
  const deps = await import("../src/agents/subagents/registry/subagent-registry-deps.js");
  const read = await import("../src/agents/subagents/registry/subagent-registry-read.js");
  const sessions = await import("../src/config/sessions/session-accessor.js");
  const tasks = await import("../src/tasks/detached-task-runtime.js");
  const events = await import("../src/infra/agent-events.js");
  const sent: Parameters<typeof sendMessage>[0][] = [];
  const localSend: typeof sendMessage = async (params) => {
    sent.push(params);
    return {
      channel: params.channel ?? "discord",
      to: params.to,
      via: "direct",
      mediaUrl: null,
      result: { messageId: `local-fixture-${sent.length}` },
    };
  };
  let synthesis: (params: Record<string, unknown>) => unknown = () => ({
    result: { payloads: [{ text: "NO_REPLY" }] },
  });
  const requesterResponses = new Map<string, (params: Record<string, unknown>) => unknown>();
  let syntheses = 0;
  const waitStarts = new Map<string, number>();
  const gateway: typeof callGateway = async <T = Record<string, unknown>>(
    request: Parameters<typeof callGateway>[0],
  ) => {
    let response: unknown;
    if (request.method === "agent.wait") {
      const params = request.params;
      assert.ok(isRecord(params), "child wait has object params");
      const runId = typeof params.runId === "string" ? params.runId : "";
      const startedAt = waitStarts.get(runId);
      assert.ok(startedAt !== undefined, `unexpected child wait: ${runId}`);
      response = { status: "timeout", startedAt };
    } else if (request.method === "agent") {
      syntheses += 1;
      const params = request.params;
      assert.ok(isRecord(params), "requester synthesis has object params");
      const requesterResponse = requesterResponses.get(String(params.sessionKey));
      response = (requesterResponse ?? synthesis)(params);
    } else {
      throw new Error(`unexpected Gateway edge: ${request.method}`);
    }
    // SAFETY: this fixture owns every scripted wire response; production decoders
    // and the assertions below validate its shape at each consumer.
    return response as T;
  };
  deliveryRuntime.setSubagentAnnounceDeliveryDepsForTest({
    callGateway: gateway,
    sendMessage: localSend,
    getRequesterSessionActivity: () => ({ sessionId: "proof-requester", isActive: false }),
    resolveRequesterSessionAbandonment: () => undefined,
  });
  announce.testing.setDepsForTest({ callGateway: gateway });
  await sessions.replaceSessionEntry(
    { sessionKey: dmRequester, agentId: "main" },
    {
      sessionId: "proof-dm-requester",
      updatedAt: Date.now(),
    },
  );
  await sessions.replaceSessionEntry(
    { sessionKey: slackRequester, agentId: "main" },
    {
      sessionId: "proof-slack-requester",
      updatedAt: Date.now(),
    },
  );

  for (const disposition of ["still-running", "exited", "killed"] as const) {
    for (const response of ["silent", "error"] as const) {
      const childSessionKey = `agent:main:subagent:direct-${disposition}-${response}`;
      const beforeSends = sent.length;
      const beforeCalls = syntheses;
      synthesis = () => {
        if (response === "error") {
          throw new Error("requester synthesis unavailable");
        }
        return { result: { payloads: [{ text: "NO_REPLY" }] } };
      };
      const event: AgentInternalEvent = {
        type: "task_completion",
        source: "subagent",
        childSessionKey,
        childSessionId: "proof-direct-child",
        announceType: "subagent task",
        taskLabel: "provisional proof",
        status: "timeout",
        disposition,
        statusLabel:
          disposition === "still-running" ? "wait expired; stop NOT observed" : "timed out",
        result:
          disposition === "still-running"
            ? "(no output observed before this wait expired; the child may still be working — re-check before acting on this)"
            : "(no output)",
        noVisibleResult: true,
        replyInstruction: "Reply NO_REPLY if no update is needed.",
      };
      const result = await delivery.deliverSubagentAnnouncement({
        requesterSessionKey: dmRequester,
        targetRequesterSessionKey: dmRequester,
        requesterAgentId: "main",
        triggerMessage: "process child observation",
        steerMessage: "process child observation",
        requesterOrigin: dmOrigin,
        requesterSessionOrigin: dmOrigin,
        completionDirectOrigin: dmOrigin,
        directOrigin: dmOrigin,
        requesterIsSubagent: false,
        expectsCompletionMessage: true,
        bestEffortDeliver: true,
        sourceSessionKey: childSessionKey,
        sourceRunId: `direct-${disposition}-${response}`,
        sourceTool: "subagent_announce",
        directIdempotencyKey: `proof-${disposition}-${response}`,
        internalEvents: [event],
      });
      assert.equal(syntheses - beforeCalls, 1, "the real requester handoff ran once");
      if (disposition === "still-running") {
        assert.equal(sent.length, beforeSends, "unconfirmed child must not send a failure notice");
        assert.equal(result.delivered, false, "silence or synthesis error is not a receipt");
        assert.equal(result.requesterVisibleFinalDelivered, undefined);
        if (response === "error") {
          assert.equal(result.disposition, "retryable");
        } else {
          assert.equal(result.reason, "message_tool_delivery_missing");
        }
      } else {
        assert.equal(
          sent.length,
          beforeSends + 1,
          "confirmed failure still emits exactly one notice",
        );
        assert.equal(sent.at(-1)?.content, failureNotice);
        assert.equal(
          result.delivered,
          true,
          "the scripted send edge returned real fixture evidence",
        );
      }
      process.stdout.write(`[pass] direct ${disposition}/${response}\n`);
    }
  }

  const observed: {
    runId: string;
    phase?: string;
    outcome: string;
    delivery?: SubagentAnnounceDeliveryResult;
  }[] = [];
  const browserCleanups: unknown[] = [];
  deps.setSubagentRegistryDepsForTest({
    callGateway: gateway,
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    cleanupBrowserSessionsForLifecycleEnd: async (params) => {
      browserCleanups.push(params);
    },
    // Observe the result while executing the entire real coordinator/delivery.
    runSubagentAnnounceFlow: async (params) => {
      let delivered: SubagentAnnounceDeliveryResult | undefined;
      const outcome = await announce.runSubagentAnnounceFlow({
        ...params,
        onDeliveryResult: (result) => {
          delivered = result;
          params.onDeliveryResult?.(result);
        },
      });
      observed.push({
        runId: params.childRunId,
        phase: params.deliveryPhase,
        outcome,
        delivery: delivered,
      });
      return outcome;
    },
  });
  const suppressedResponse = () => ({
    result: {
      payloads: [{ text: "A policy-suppressed provisional update." }],
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "suppressed",
        succeeded: true,
        resultCount: 0,
        reason: "cancelled_by_message_sending_hook",
      },
    },
  });
  const successResponse = () => ({
    result: {
      payloads: [{ text: finalText }],
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "sent",
        succeeded: true,
        resultCount: 1,
      },
    },
  });
  for (const mode of ["intentional_non_delivery", "permanent_failure", "retryable"] as const) {
    const runId = `provisional-${mode}`;
    const childSessionKey = `agent:main:subagent:${runId}`;
    const requesterSessionKey = `${slackRequester}-${mode}`;
    await sessions.replaceSessionEntry(
      { sessionKey: requesterSessionKey, agentId: "main" },
      {
        sessionId: `requester-${runId}`,
        updatedAt: Date.now(),
      },
    );
    const taskCreatedAfter = Date.now();
    const startedAt = Date.now() - 1_000;
    waitStarts.set(runId, startedAt);
    await sessions.replaceSessionEntry(
      { sessionKey: childSessionKey, agentId: "main" },
      {
        sessionId: `session-${runId}`,
        updatedAt: Date.now(),
        status: "running",
        startedAt,
      },
    );
    let provisionalCalls = 0;
    let completing = false;
    requesterResponses.set(requesterSessionKey, (params) => {
      assert.equal(params.deliver, true, "registry proof must reach the automatic external route");
      if (completing) {
        return successResponse();
      }
      assert.ok(Array.isArray(params.internalEvents));
      assert.equal(params.internalEvents.length, 1);
      const event: unknown = params.internalEvents[0];
      assert.ok(event && typeof event === "object");
      assert.equal("childSessionKey" in event && event.childSessionKey, childSessionKey);
      assert.equal("status" in event && event.status, "timeout");
      assert.equal("disposition" in event && event.disposition, "still-running");
      assert.equal("noVisibleResult" in event && event.noVisibleResult, true);
      provisionalCalls += 1;
      if (mode === "permanent_failure") {
        throw new Error("chat not found");
      }
      if (mode === "retryable" && provisionalCalls === 1) {
        throw new Error("requester synthesis unavailable");
      }
      return suppressedResponse();
    });
    const run = () =>
      read.listSubagentRunsForRequester(requesterSessionKey).find((row) => row.runId === runId);
    const task = () =>
      tasks.findDetachedTaskRun({
        runId,
        runtime: "subagent",
        sessionKey: childSessionKey,
        createdAtOrAfter: taskCreatedAfter,
      });
    const taskStatus = () => {
      const found = task();
      return found.lookup === "available" ? found.task?.status : undefined;
    };
    const phaseResults = () =>
      observed.filter((item) => item.runId === runId && item.phase === "wait-expiry");
    const cleanupCount = browserCleanups.length;
    const sendCount = sent.length;
    registry.registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey,
      requesterAgentId: "main",
      requesterOrigin: slackOrigin,
      requesterDisplayKey: "proof",
      task: "notification settlement must not settle its child",
      cleanup: "keep",
      runTimeoutSeconds: 1,
      expectsCompletionMessage: true,
      taskRowOwnership: "required",
    });
    assert.equal(taskStatus(), "running", "launch owns a real SQLite task");
    await until(`${mode}: first notification result`, () => phaseResults().length > 0);
    assert.equal(phaseResults()[0]?.outcome, mode);
    assert.equal(phaseResults()[0]?.delivery?.delivered, false);
    assert.equal(phaseResults()[0]?.delivery?.requesterVisibleFinalDelivered, undefined);
    if (mode === "retryable") {
      assert.equal(run()?.waitExpiryAnnouncedAt, undefined, "retryable result is not settled");
    }
    await until(
      `${mode}: notification settled`,
      () => typeof run()?.waitExpiryAnnouncedAt === "number",
    );
    assert.equal(phaseResults().length, mode === "retryable" ? 2 : 1);
    if (mode === "retryable") {
      assert.equal(phaseResults()[1]?.outcome, "intentional_non_delivery");
    }
    // Production retry cadence is 5s. Wait beyond it to prove a settled outcome
    // does not schedule another attempt; no fake time or test-mode cadence.
    const settledCalls = provisionalCalls;
    await sleep(5_500);
    assert.equal(provisionalCalls, settledCalls, "settled notification must not be resynthesized");
    assert.equal(run()?.execution.status, "running");
    assert.equal(run()?.execution.endedAt, undefined);
    assert.equal(run()?.completion?.resultText, undefined);
    assert.equal(taskStatus(), "running");
    assert.equal(
      browserCleanups.length,
      cleanupCount,
      "notification did not clean up child resources",
    );
    assert.equal(sent.length, sendCount, "no direct failed-child notice from provisional event");

    completing = true;
    events.emitAgentEvent({
      runId,
      stream: "lifecycle",
      sessionKey: childSessionKey,
      data: {
        phase: "end",
        startedAt,
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: finalText },
      },
    });
    await until(`${mode}: same child succeeds`, () => taskStatus() === "succeeded");
    await until(`${mode}: final delivery`, () =>
      observed.some((item) => item.runId === runId && !item.phase),
    );
    await until(
      `${mode}: cleanup bookkeeping`,
      () => run()?.cleanupHandled === true && !run()?.requesterSettleWake,
    );
    assert.equal(run()?.execution.status, "terminal");
    assert.equal(run()?.execution.outcome?.status, "ok");
    assert.equal(run()?.completion?.resultText, finalText);
    assert.equal(
      observed.find((item) => item.runId === runId && !item.phase)?.outcome,
      "delivered",
    );
    process.stdout.write(
      `[pass] registry ${mode}: notification settled, same child later succeeded\n`,
    );
  }
  process.stdout.write(
    "PASS: six direct-delivery controls and three real registry lifecycle scenarios\n",
  );
} catch (error) {
  exitCode = 1;
  const detail: string = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
} finally {
  await heartbeat.terminate();
  // This process owns this fresh directory only. Production timers may remain;
  // exit closes its private SQLite handles rather than waiting for live children.
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
