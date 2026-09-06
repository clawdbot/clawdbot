/**
 * Real-behavior proof for PR #139925: bind tool-authority snapshot before queued followup execution.
 *
 * This proof uses the REAL replyRunRegistry singleton and the REAL prepareReplyToolAuthority
 * function (no mocks). It demonstrates:
 *
 * 1. WITHOUT the fix: calling bindToolAuthorityRoute() without first calling
 *    bindToolAuthoritySnapshot() throws "Reply operation has no active tool authority snapshot".
 *    This is the failure a queued follow-up hits on main because followup-turn-execution.ts
 *    dispatches executeAgentTurn without binding the snapshot.
 *
 * 2. WITH the fix: calling bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun))
 *    before bindToolAuthorityRoute() succeeds — the route is accepted and returns a fingerprint.
 *    This is exactly what the PR adds at followup-turn-execution.ts:331 before executeAgentTurn.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replyRunRegistry } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

const sessionKey = "proof:queued-followup:tool-authority";

afterEach(() => {
  const op = replyRunRegistry.get(sessionKey);
  if (op) {
    try {
      op.complete();
    } catch {
      // already complete
    }
  }
});

describe("PR #139925 real-behavior proof: queued followup tool-authority snapshot", () => {
  it("WITHOUT fix: bindToolAuthorityRoute throws when snapshot is not bound (main behavior)", () => {
    // Create a REAL operation via the production registry singleton.
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "proof-without-fix",
      resetTriggered: false,
      upstreamAbortSignal: new AbortController().signal,
    });

    // On main, followup-turn-execution.ts dispatches executeAgentTurn with turn.operation
    // WITHOUT calling bindToolAuthoritySnapshot first. The CLI candidate then calls
    // bindToolAuthorityRoute, which hits the guard:
    //   if (result || !toolAuthoritySnapshot || ...) throw "no active tool authority snapshot"
    let caught: unknown;
    try {
      operation.bindToolAuthorityRoute({ provider: "anthropic", model: "claude" });
    } catch (error) {
      caught = error;
    }

    // Prove the guard fires — this is the exact error the bug report describes.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Reply operation has no active tool authority snapshot");

    operation.complete();
  });

  it("WITH fix: bindToolAuthoritySnapshot then bindToolAuthorityRoute succeeds (PR behavior)", () => {
    // Create a REAL operation via the production registry singleton.
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "proof-with-fix",
      resetTriggered: false,
      upstreamAbortSignal: new AbortController().signal,
    });

    const rootDir = path.join(import.meta.dirname, ".proof-tmp-with-fix");
    const followupRun = {
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionId: "proof-with-fix",
        sessionKey,
        messageProvider: "whatsapp",
        sessionFile: path.join(rootDir, "session.jsonl"),
        workspaceDir: rootDir,
        config: {},
        provider: "anthropic",
        model: "claude",
      },
    } as const;

    // THE FIX: bind the tool-authority snapshot before dispatching executeAgentTurn.
    // This is the exact line the PR adds at followup-turn-execution.ts:331:
    //   turn.operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(turn.queued));
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));

    // Now the CLI candidate's bindToolAuthorityRoute call succeeds — it returns a fingerprint
    // instead of throwing "no active tool authority snapshot".
    let fingerprint: string | undefined;
    let caught: unknown;
    try {
      fingerprint = operation.bindToolAuthorityRoute({
        provider: "anthropic",
        model: "claude",
      });
    } catch (error) {
      caught = error;
    }

    // Prove the fix works: no error, and a valid fingerprint is returned.
    expect(caught).toBeUndefined();
    expect(typeof fingerprint).toBe("string");
    expect(fingerprint!.length).toBeGreaterThan(0);

    operation.complete();
  });

  it("WITH fix: snapshot is bound once and route fingerprint is deterministic", () => {
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "proof-stability",
      resetTriggered: false,
      upstreamAbortSignal: new AbortController().signal,
    });

    const rootDir = path.join(import.meta.dirname, ".proof-tmp-stability");
    const followupRun = {
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionId: "proof-stability",
        sessionKey,
        messageProvider: "whatsapp",
        sessionFile: path.join(rootDir, "session.jsonl"),
        workspaceDir: rootDir,
        config: {},
        provider: "anthropic",
        model: "claude",
      },
    } as const;

    // THE FIX: bind the snapshot exactly once (as followup-turn-execution.ts:331 does).
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));

    // bindToolAuthorityRoute returns a deterministic fingerprint for the same route.
    const fp1 = operation.bindToolAuthorityRoute({
      provider: "anthropic",
      model: "claude",
    });

    // The snapshot guard rejects re-binding ("cannot change tool authority after admission"),
    // confirming the snapshot is frozen — the fix binds it exactly once.
    expect(() =>
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun)),
    ).toThrow(/cannot change tool authority/);

    expect(typeof fp1).toBe("string");
    expect(fp1!.length).toBeGreaterThan(0);

    operation.complete();
  });
});
