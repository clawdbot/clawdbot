// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import { createSessionDeletionHarness } from "./session-deletion.test-support.ts";

describe("session deletion generation ownership", () => {
  it.each(["history", "changed", "message"] as const)(
    "rejects an old %s generation before it can replace a rolled-back row",
    async (source) => {
      const h = createSessionDeletionHarness();
      try {
        await h.sessions.refresh({ force: true });
        const current = { ...h.alpha, sessionId: "generation-b" };
        h.setRows([current, h.sibling]);
        await h.sessions.refresh({ force: true });
        const operation = h.sessions.delete(current.key, { expectedSessionId: current.sessionId });
        h.responses.get(current.key)!.resolve({ deleted: false });
        await operation;
        const payload = {
          sessionKey: h.alpha.key,
          reason: "message",
          session: h.alpha,
          hasActiveRun: false,
        };
        if (source === "history") {
          h.sessions.reconcile(h.alpha);
        } else if (source === "changed") {
          h.sessions.reconcileChanged(payload);
        } else {
          h.emitEvent({ type: "event", event: "session.message", payload });
        }
        expect(h.sessions.state.result?.sessions).toEqual([current, h.sibling]);
      } finally {
        h.responses.get(h.alpha.key)?.resolve({ deleted: false });
        h.sessions.dispose();
      }
    },
  );

  it("uses the actual bootstrap fallback request to establish a fresh replacement", async () => {
    const h = createSessionDeletionHarness();
    const subscribe = createDeferred<{ subscribed: boolean }>();
    try {
      await h.sessions.refresh({ force: true });
      h.publish(false);
      h.request.mockImplementationOnce(() => subscribe.promise);
      h.publish(true);
      const operation = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
      const replacement = { ...h.alpha, sessionId: "replacement-after-subscribe" };
      h.setRows([replacement, h.sibling]);
      subscribe.resolve({ subscribed: true });
      await vi.waitFor(() => expect(h.sessions.state.result?.sessions).toContainEqual(replacement));
      expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
      h.responses.get(h.alpha.key)!.resolve({ deleted: true });
      await operation;
      expect(h.sessions.state.result?.sessions).toContainEqual(replacement);
    } finally {
      subscribe.resolve({ subscribed: true });
      h.responses.get(h.alpha.key)?.resolve({ deleted: false });
      h.sessions.dispose();
    }
  });

  it.each(["managed", "enumeration"] as const)(
    "keeps a fresh replacement ahead of a slower post-admission %s generation",
    async (source) => {
      const h = createSessionDeletionHarness();
      const older = createDeferred<SessionsListResult>();
      const scope = { archivedFilter: "all" as const };
      const stop = h.sessions.subscribeList(scope, () => {});
      const facts: string[] = [];
      h.sessions.subscribe((state) => facts.push(...state.deletedSessions.map(({ key }) => key)));
      try {
        await h.sessions.refresh({ force: true });
        const operation = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
        h.setListResponse(older.promise);
        const stale =
          source === "managed"
            ? h.sessions.refreshList(scope).then(() => h.sessions.listSnapshot(scope).result)
            : h.sessions.list();
        h.setListResponse();
        const replacement = { ...h.alpha, sessionId: "newest-generation" };
        h.setRows([replacement, h.sibling]);
        await h.sessions.refresh({ force: true });
        older.resolve(sessionsResult([{ ...h.alpha, sessionId: "intermediate-generation" }], 1));
        expect((await stale)?.sessions).toEqual([]);
        h.responses.get(h.alpha.key)!.resolve({ deleted: true });
        await operation;
        expect(facts).toEqual([]);
        expect(h.sessions.state.result?.sessions).toContainEqual(replacement);
      } finally {
        older.resolve(sessionsResult([], 1));
        h.responses.get(h.alpha.key)?.resolve({ deleted: false });
        stop();
        h.sessions.dispose();
      }
    },
  );

  it.each(
    (["bootstrap", "primary", "managed", "enumeration"] as const).flatMap((source) =>
      (["confirmed", "rejected"] as const).flatMap((outcome) =>
        [false, true].map((afterSettlement) => ({ source, outcome, afterSettlement })),
      ),
    ),
  )(
    "fences older $source A while B is $outcome (delivery after settlement: $afterSettlement)",
    async ({ source, outcome, afterSettlement }) => {
      const h = createSessionDeletionHarness();
      const older = createDeferred<SessionsListResult>();
      const scope = { archivedFilter: "all" as const };
      const publishedIds: Array<string | undefined> = [];
      const stop = h.sessions.subscribeList(scope, ({ result }) => {
        publishedIds.push(...(result?.sessions.map((row) => row.sessionId) ?? []));
      });
      const facts: string[] = [];
      h.sessions.subscribe((state) => {
        publishedIds.push(...(state.result?.sessions.map((row) => row.sessionId) ?? []));
        facts.push(...state.deletedSessions.map(({ key }) => key));
      });
      try {
        h.setRows([h.sibling]);
        let stale: Promise<SessionsListResult | null>;
        if (source === "bootstrap") {
          h.request.mockImplementationOnce(async () => ({
            subscribed: true,
            list: await older.promise,
          }));
          h.publish(true);
          stale = vi
            .waitFor(() => expect(h.sessions.state.result).not.toBeNull())
            .then(() => h.sessions.state.result);
        } else {
          await h.sessions.refresh({ force: true });
          h.setListResponse(older.promise);
          stale =
            source === "enumeration"
              ? h.sessions.list()
              : h.sessions
                  .refreshList(source === "managed" ? scope : { force: true })
                  .then(() => h.sessions.listSnapshot(source === "managed" ? scope : {}).result);
        }
        h.setListResponse();
        const current = { ...h.alpha, sessionId: "generation-b" };
        h.setRows([current, h.sibling]);
        await h.sessions.refreshList(
          source === "primary" || source === "bootstrap" ? scope : { force: true },
        );
        const operation = h.sessions.delete(current.key, { expectedSessionId: current.sessionId });
        const settled = operation.then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
        expect(h.sessions.deletionState(current.key)).toBe("pending");
        h.setRows(outcome === "confirmed" ? [h.sibling] : [current, h.sibling]);
        const settle = () => {
          if (outcome === "confirmed") {
            h.responses.get(current.key)!.resolve({ deleted: true });
          } else {
            h.responses.get(current.key)!.reject(new Error("reclaim failed"));
          }
        };
        if (afterSettlement) {
          settle();
          await vi.waitFor(() => expect(h.sessions.deletionState(current.key)).not.toBe("pending"));
        }
        older.resolve(sessionsResult([h.alpha, h.sibling], 1));
        expect((await stale)?.sessions).not.toContainEqual(h.alpha);
        if (!afterSettlement) {
          expect(h.sessions.deletionState(current.key)).toBe("pending");
          settle();
        }
        const result = await settled;
        if (outcome === "confirmed") {
          expect(result.value).toEqual({ deleted: true });
        } else {
          expect(result.error).toEqual(new Error("reclaim failed"));
        }
        expect(publishedIds).not.toContain(h.alpha.sessionId);
        expect(facts.includes(current.key)).toBe(outcome === "confirmed");
        if (outcome === "rejected") {
          expect(
            h.sessions.listSnapshot(source === "primary" || source === "bootstrap" ? scope : {})
              .result?.sessions,
          ).toContainEqual(current);
        }
      } finally {
        older.resolve(sessionsResult([], 1));
        h.responses.get(h.alpha.key)?.resolve({ deleted: false });
        stop();
        h.sessions.dispose();
      }
    },
  );

  it.each(["primary", "managed"] as const)(
    "keeps cached %s and history generations from retiring the current deletion",
    async (cached) => {
      const h = createSessionDeletionHarness();
      const scope = { archivedFilter: "all" as const };
      const stop = h.sessions.subscribeList(scope, () => {});
      try {
        h.setRows([h.alpha, h.sibling]);
        await h.sessions.refreshList(cached === "managed" ? scope : { force: true });
        const current = { ...h.alpha, sessionId: "generation-b" };
        h.setRows([current, h.sibling]);
        const currentScope = cached === "managed" ? {} : scope;
        await h.sessions.refreshList({ ...currentScope, force: true });
        const operation = h.sessions.delete(current.key, { expectedSessionId: current.sessionId });
        h.sessions.reconcile(h.alpha);
        h.sessions.reconcileChanged({ ...h.alpha, sessionKey: h.alpha.key, reason: "send" });
        h.emitEvent({
          type: "event",
          event: "session.message",
          payload: { session: h.alpha, hasActiveRun: false },
        });
        expect(h.sessions.deletionState(current.key)).toBe("pending");
        expect(h.sessions.state.result?.sessions).toEqual([h.sibling]);
        expect(h.sessions.listSnapshot(scope).result?.sessions).not.toContainEqual(h.alpha);
        h.responses.get(current.key)!.resolve({ deleted: false });
        await operation;
        expect(h.sessions.listSnapshot(currentScope).result?.sessions).toContainEqual(current);
        expect(h.sessions.listSnapshot(scope).result?.sessions).not.toContainEqual(h.alpha);
      } finally {
        h.responses.get(h.alpha.key)?.resolve({ deleted: false });
        stop();
        h.sessions.dispose();
      }
    },
  );

  it.each(["bootstrap", "primary", "managed", "enumeration"] as const)(
    "resolves an unloaded deletion from fresh %s membership after reconnect",
    async (kind) => {
      const h = createSessionDeletionHarness();
      const scope = { archivedFilter: "all" as const };
      const stop = h.sessions.subscribeList(scope, () => {});
      try {
        h.setRows([h.sibling]);
        await h.sessions.refresh({ force: true });
        h.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey: h.alpha.key,
            reason: "delete",
            sessionId: h.alpha.sessionId,
            agentId: "main",
          },
        });
        expect(h.sessions.deletionState(h.alpha.key)).toBe("confirmed");
        h.publish(false);
        const replacement = { ...h.alpha, sessionId: "replacement-alpha" };
        // The create event was missed; other windows may also sit outside bootstrap's roster.
        if (kind === "bootstrap") {
          h.setRows([replacement, h.sibling]);
        }
        h.publish(true);
        await vi.waitFor(() => expect(h.sessions.state.result).not.toBeNull());
        if (kind === "bootstrap") {
          expect(h.sessions.state.result?.sessions).toContainEqual(replacement);
          expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
          return;
        }
        h.setRows([replacement, h.sibling]);
        if (kind === "enumeration") {
          expect((await h.sessions.list(scope))?.sessions).toContainEqual(replacement);
        } else {
          await h.sessions.refreshList(
            kind === "managed" ? { ...scope, force: true } : { force: true },
          );
          expect(
            h.sessions.listSnapshot(kind === "managed" ? scope : {}).result?.sessions,
          ).toContainEqual(replacement);
        }
        expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
      } finally {
        stop();
        h.sessions.dispose();
      }
    },
  );

  it.each(["primary", "managed", "enumeration"] as const)(
    "keeps pre-delete %s responses fenced after fresh membership resolves an unloaded deletion",
    async (kind) => {
      const h = createSessionDeletionHarness();
      const staleList = createDeferred<SessionsListResult>();
      const scope = { archivedFilter: "all" as const };
      const stop = h.sessions.subscribeList(scope, () => {});
      try {
        h.setRows([h.sibling]);
        await h.sessions.refresh({ force: true });
        h.setListResponse(staleList.promise);
        const stale =
          kind === "enumeration"
            ? h.sessions.list(scope)
            : h.sessions
                .refreshList(kind === "managed" ? scope : { force: true })
                .then(() => h.sessions.listSnapshot(kind === "managed" ? scope : {}).result);
        h.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey: h.alpha.key,
            reason: "delete",
            sessionId: h.alpha.sessionId,
            agentId: "main",
          },
        });
        const replacement = { ...h.alpha, sessionId: "replacement-alpha" };
        h.setListResponse();
        h.setRows([replacement, h.sibling]);
        expect((await h.sessions.list())?.sessions).toContainEqual(replacement);
        staleList.resolve(sessionsResult([h.alpha, h.sibling], 1));
        const result = await stale;
        expect(result?.sessions).not.toContainEqual(h.alpha);
        expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
      } finally {
        staleList.resolve(sessionsResult([], 1));
        stop();
        h.sessions.dispose();
      }
    },
  );

  it.each(["confirmed", "rejected"] as const)(
    "retains retired generations while a successor deletion is %s",
    async (outcome) => {
      const h = createSessionDeletionHarness();
      try {
        await h.sessions.refresh({ force: true });
        const first = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
        h.setRows([h.sibling]);
        h.responses.get(h.alpha.key)!.resolve({ deleted: true });
        await first;
        const replacement = { ...h.alpha, sessionId: "replacement-alpha" };
        h.setRows([replacement, h.sibling]);
        await h.sessions.refresh({ force: true });
        const facts: string[] = [];
        h.sessions.subscribe((state) => facts.push(...state.deletedSessions.map(({ key }) => key)));
        const next = h.sessions.delete(h.alpha.key, { expectedSessionId: replacement.sessionId });
        h.setRows([h.alpha, h.sibling]);
        await h.sessions.refresh({ force: true });
        expect(h.sessions.state.result?.sessions).not.toContainEqual(h.alpha);
        expect(h.sessions.deletionState(h.alpha.key)).toBe("pending");
        expect(h.sessions.deletionState(h.alpha.key, "main", h.alpha.sessionId)).toBe("confirmed");
        h.setRows(outcome === "confirmed" ? [h.sibling] : [replacement, h.sibling]);
        const settled =
          outcome === "confirmed"
            ? expect(next).resolves.toEqual({ deleted: true })
            : expect(next).rejects.toThrow("successor reclaim failed");
        if (outcome === "confirmed") {
          h.responses.get(h.alpha.key)!.resolve({ deleted: true });
        } else {
          h.responses.get(h.alpha.key)!.reject(new Error("successor reclaim failed"));
        }
        await settled;
        expect(facts.includes(h.alpha.key)).toBe(outcome === "confirmed");
        h.setRows([h.alpha, h.sibling]);
        await h.sessions.refresh({ force: true });
        expect(h.sessions.state.result?.sessions).not.toContainEqual(h.alpha);
      } finally {
        h.responses.get(h.alpha.key)?.resolve({ deleted: false });
        h.sessions.dispose();
      }
    },
  );
});
