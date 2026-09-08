import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue.js";
import { forceClearReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import {
  prepareReplyToolAuthority,
  resolveFollowupRunToolAuthorityFingerprint,
} from "./reply-tool-authority.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

// Only Gateway-backed secret resolution and preflight compaction are stubbed;
// admission, the reply-run registry, and tool authority snapshots are real.
vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: async (config: OpenClawConfig) => config,
}));
vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: async ({ sessionEntry }: { sessionEntry: unknown }) => sessionEntry,
}));

const { admitFollowupTurn } = await import("./followup-turn-admission.js");

const SESSION_KEY = "agent:main:telegram:direct:1";
const ROUTE = { provider: "anthropic", model: "claude-opus-5" };

function createRun(prompt: string): FollowupRun {
  return {
    prompt,
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-1",
      sessionKey: SESSION_KEY,
      sessionFile: "/tmp/session-1.jsonl",
      workspaceDir: "/tmp",
      config: {} as OpenClawConfig,
      provider: ROUTE.provider,
      model: ROUTE.model,
      messageProvider: "telegram",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

describe("queued follow-up handoff after an active reply run", () => {
  const operations: ReplyOperation[] = [];
  afterEach(() => {
    for (const operation of operations.splice(0)) {
      forceClearReplyOperation(operation);
    }
  });

  it("lets the queued turn bind its concrete route once the active run completes", async () => {
    // Message #1 starts a foreground run and binds its authority like agent-runner-run does.
    const foreground = await admitReplyTurn({
      sessionId: "session-1",
      sessionKey: SESSION_KEY,
      kind: "visible",
      resetTriggered: false,
      waitForActive: false,
    });
    expect(foreground.status).toBe("owned");
    if (foreground.status !== "owned") {
      return;
    }
    operations.push(foreground.operation);
    foreground.operation.bindToolAuthoritySnapshot(
      prepareReplyToolAuthority(createRun("message #1")),
    );
    expect(foreground.operation.bindToolAuthorityRoute(ROUTE)).toBeTypeOf("string");

    // Message #2 arrives while #1 is active: admission waits for the run to end.
    const queued = createRun("message #2");
    const queuedAdmission = admitFollowupTurn({
      queued,
      defaults: {
        typing: {} as never,
        typingMode: "never",
        defaultModel: ROUTE.model,
        sessionKey: SESSION_KEY,
      },
    });
    await sleep(20);
    foreground.operation.complete();

    const result = await queuedAdmission;
    expect(result.kind).toBe("admitted");
    if (result.kind !== "admitted") {
      return;
    }
    operations.push(result.turn.operation);
    expect(result.turn.operation).not.toBe(foreground.operation);
    // The queued turn's own authority must be bound before a backend selects its route.
    expect(result.turn.operation.bindToolAuthorityRoute(ROUTE)).toBe(
      resolveFollowupRunToolAuthorityFingerprint(result.turn.queued, ROUTE),
    );
  });
});
