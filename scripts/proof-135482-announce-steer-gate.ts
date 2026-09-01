/**
 * Real-behavior proof for the reply-run completion steer route (PR #135482).
 *
 * This script exists to answer one question honestly, because review found the
 * PR's claim overstated: **which production reply backends can this new route
 * actually inject into?** It enumerates every shape a production site attaches
 * and runs each one through the real injector, rather than asserting a
 * fabricated capability.
 *
 * What is REAL here (no vitest, no mocks of the seam under test):
 *   - `createReplyOperation()` — the production reply-run registry, so each
 *     scenario has a genuinely live, registered, running reply operation whose
 *     session id resolves the way `resolveReplyRunForCurrentSessionId` expects.
 *   - `attachBackend()` — the production attachment API the CLI, worker, and
 *     embedded owners all call.
 *   - `queueEmbeddedAgentMessageWithOutcomeAsync()` — the changed production
 *     injector, driven end to end with no embedded run registered for the
 *     session, which is exactly the state the new route was added to serve.
 *
 * The backend handles are transcribed field-for-field from their production
 * construction sites (cited inline). Nothing is added to them: a handle that
 * lacks `messageInjection` and `queueMessage` here lacks them in production too,
 * and that is the point.
 *
 * What is NOT proved: that a subagent completion reaches a live reply-backed
 * *CLI* parent. It does not, and this script demonstrates why rather than
 * claiming otherwise — no CLI execution owner exposes a message-injection
 * transport, so the route resolves `injection_unavailable` and the caller keeps
 * its direct handoff.
 *
 * Run: pnpm tsx scripts/proof-135482-announce-steer-gate.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ReplyOperation = import("../src/auto-reply/reply/reply-run-registry.js").ReplyOperation;

let failures = 0;

function check(label: string, run: () => void): void {
  try {
    run();
    console.log(`   ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`   ✗ ${label}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  process.env.OPENCLAW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-135482-"));

  const replyRegistry = await import("../src/auto-reply/reply/reply-run-registry.js");
  const runs = await import("../src/agents/embedded-agent-runner/runs.js");

  let seq = 0;
  /** Stands up a genuinely live, registered, running reply operation. */
  const liveReplyRun = (): { operation: ReplyOperation; sessionId: string } => {
    seq += 1;
    const sessionId = `proof-session-${seq}`;
    const operation = replyRegistry.createReplyOperation({
      sessionKey: `agent:main:proof-${seq}`,
      sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    return { operation, sessionId };
  };

  const steer = async (sessionId: string, options: Record<string, unknown>) =>
    await runs.queueEmbeddedAgentMessageWithOutcomeAsync(
      sessionId,
      "child completed",
      options as never,
    );

  const OPT_IN = { steeringMode: "all", allowReplyRunInjection: true } as const;

  console.log("── the session has no embedded run in any scenario below ──");

  console.log("── scenario 1: CLI backend, exactly as execute-process.ts:283 builds it ──");
  {
    const { operation, sessionId } = liveReplyRun();
    // src/agents/cli-runner/execute-process.ts:283-290. execute-plugin.ts:487 and
    // execute-node-claude.ts:187 attach the same four fields.
    operation.attachBackend({
      kind: "cli" as const,
      runId: "cli-run-1",
      toolAuthorityFingerprint: "fp-cli",
      cancel: () => {},
    });
    assert.equal(runs.isEmbeddedAgentRunActive(sessionId), true, "gate must report this active");
    const outcome = await steer(sessionId, OPT_IN);
    console.log(`   outcome: ${JSON.stringify(outcome)}`);
    check("a CLI-backed parent is NOT steerable — the route falls back, as review found", () => {
      assert.equal(outcome.queued, false);
      assert.equal(outcome.reason, "not_streaming");
    });
    check("but the parent is no longer misreported as having no active run", () => {
      // Before this PR the same state answered `no_active_run`, which is false:
      // the parent is emphatically running. `not_streaming` is the true fact.
      assert.notEqual(outcome.reason, "no_active_run");
    });
    operation.abort?.("proof");
  }

  console.log("── scenario 2: cloud worker backend, as worker-turn-run-owner.ts:117 builds it ──");
  {
    const { operation, sessionId } = liveReplyRun();
    const queueMessage = async () => {
      throw new Error("Cloud worker turns do not support message injection");
    };
    operation.attachBackend({
      kind: "embedded" as const,
      runId: "worker-run-1",
      queueMessage,
      messageInjection: { isAvailable: () => false, queueMessage },
      isStreaming: () => false,
      isStopped: () => false,
      cancel: () => {},
    });
    const outcome = await steer(sessionId, OPT_IN);
    console.log(`   outcome: ${JSON.stringify(outcome)}`);
    check("a backend that declares injection unavailable is refused, not attempted", () => {
      assert.equal(outcome.queued, false);
      assert.equal(outcome.reason, "not_streaming");
    });
    operation.abort?.("proof");
  }

  console.log("── scenario 3: injectable backend, as attempt-stream-prepare.ts:573 builds it ──");
  {
    const { operation, sessionId } = liveReplyRun();
    const injected: string[] = [];
    const queueMessage = async (text: string) => {
      injected.push(text);
    };
    operation.attachBackend({
      kind: "embedded" as const,
      runId: "injectable-run-1",
      queueMessage,
      messageInjection: { isAvailable: () => true, queueMessage },
      isStreaming: () => true,
      isStopped: () => false,
      cancel: () => {},
    });
    const outcome = await steer(sessionId, OPT_IN);
    console.log(`   outcome: ${JSON.stringify(outcome)}`);
    console.log(`   text delivered to the backend: ${JSON.stringify(injected)}`);
    check("the steer reaches a reply backend that really can accept one", () => {
      assert.equal(outcome.queued, true);
      assert.equal(outcome.target, "reply_run");
      assert.deepEqual(injected, ["child completed"]);
    });
    operation.abort?.("proof");
  }

  console.log("── scenario 4: legacy queueMessage-only backend (no messageInjection) ──");
  {
    const { operation, sessionId } = liveReplyRun();
    const injected: string[] = [];
    operation.attachBackend({
      kind: "embedded" as const,
      runId: "legacy-run-1",
      queueMessage: async (text: string) => {
        injected.push(text);
      },
      cancel: () => {},
    });
    const outcome = await steer(sessionId, OPT_IN);
    console.log(`   outcome: ${JSON.stringify(outcome)}`);
    check("the shipped-handle compatibility shape is served too", () => {
      assert.equal(outcome.queued, true);
      assert.equal(outcome.target, "reply_run");
      assert.deepEqual(injected, ["child completed"]);
    });
    operation.abort?.("proof");
  }

  console.log("── scenario 5: callers that did not opt in are unchanged ──");
  {
    const { operation, sessionId } = liveReplyRun();
    const queueMessage = async () => {};
    operation.attachBackend({
      kind: "embedded" as const,
      runId: "no-opt-in-run",
      queueMessage,
      messageInjection: { isAvailable: () => true, queueMessage },
      cancel: () => {},
    });
    const outcome = await steer(sessionId, { steeringMode: "all" });
    console.log(`   outcome: ${JSON.stringify(outcome)}`);
    check("without the opt-in the injector still answers no_active_run", () => {
      assert.equal(outcome.queued, false);
      assert.equal(outcome.reason, "no_active_run");
    });
    operation.abort?.("proof");
  }

  console.log("── scenario 6: transcript-commit demand precedes the reply route ──");
  {
    const { operation, sessionId } = liveReplyRun();
    const queueMessage = async () => {};
    operation.attachBackend({
      kind: "embedded" as const,
      runId: "commit-wait-run",
      queueMessage,
      messageInjection: { isAvailable: () => true, queueMessage },
      cancel: () => {},
    });
    const outcome = await steer(sessionId, { ...OPT_IN, waitForTranscriptCommit: true });
    console.log(`   outcome: ${JSON.stringify(outcome)}`);
    check("a caller demanding transcript commitment is told it is unsupported first", () => {
      // The announce wake then drops the flag and retries; that best-effort
      // retry is the only attempt a reply-backed-only requester is served on.
      assert.equal(outcome.queued, false);
      assert.equal(outcome.reason, "transcript_commit_wait_unsupported");
    });
    operation.abort?.("proof");
  }

  console.log("");
  console.log("Summary of production reply-backend shapes against the real injector:");
  console.log("   cli (execute-process / execute-plugin / execute-node-claude) -> NOT served");
  console.log("   cloud worker turn (declares injection unavailable)           -> NOT served");
  console.log("   embedded attempt stream / legacy queueMessage handle         -> served");

  if (failures > 0) {
    console.log(`\n${failures} runtime assertion(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll runtime assertions passed.");
  process.exit(0);
}

await main();
