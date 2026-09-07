// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

function sessionRow(key: string, overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    sessionId: `${key}-generation`,
    updatedAt: 1,
    permissionMode: "guarded",
    archived: false,
    hasActiveRun: true,
    status: "running",
    ...overrides,
  };
}

function harness(...responses: Array<SessionsListResult | Promise<SessionsListResult> | Error>) {
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected additional session list request");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  const capability = createSessionCapabilityHarness(
    request as unknown as GatewayBrowserClient["request"],
  );
  return {
    ...capability,
    request,
    permissionEvent: (row: GatewaySessionRow, agentId = "main") => {
      capability.emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          agentId,
          sessionKey: row.key,
          hasActiveRun: true,
          status: "running",
          session: { ...row, permissionMode: row.permissionMode ?? null },
        },
      });
    },
  };
}

const managedScope = {
  agentId: "main",
  includeDerivedTitles: false,
  includeLastMessage: false,
  limit: 50,
};

describe("permission projection across canonical session lists", () => {
  it("keeps a newer permission without restamping unrelated fields from an older list", async () => {
    const existing = sessionRow("agent:main:field-order", { label: "Initial" });
    const pending = createDeferred<SessionsListResult>();
    const response = sessionsResult([{ ...existing, updatedAt: 2, label: "Older list" }], 2);
    const { sessions, permissionEvent } = harness(
      sessionsResult([existing], 1),
      pending.promise,
      sessionsResult([{ ...existing, updatedAt: 5, permissionMode: "workspace" }], 5),
    );
    let refresh: Promise<void> | undefined;
    try {
      await sessions.refresh({ force: true });
      refresh = sessions.refresh({ force: true });
      permissionEvent({ ...existing, updatedAt: 3, permissionMode: "full" });
      await sessions.refreshList(managedScope);
      pending.resolve(response);
      await refresh;
      permissionEvent({
        ...existing,
        updatedAt: 4,
        label: "Newer event",
        permissionMode: "guarded",
      });

      expect(sessions.state.result?.sessions[0]).toMatchObject({
        label: "Newer event",
        permissionMode: "workspace",
        updatedAt: 4,
      });
      expect(sessions.state.loading).toBe(false);
    } finally {
      pending.resolve(response);
      await refresh;
      sessions.dispose();
    }
  });

  it("accepts a newer canonical permission even when its request began before the event", async () => {
    const existing = sessionRow("agent:main:newer-list");
    const pending = createDeferred<SessionsListResult>();
    const response = sessionsResult(
      [{ ...existing, updatedAt: 5, permissionMode: "workspace", label: "Newest" }],
      5,
    );
    const { sessions, permissionEvent } = harness(sessionsResult([existing], 1), pending.promise);
    let refresh: Promise<void> | undefined;
    try {
      await sessions.refresh({ force: true });
      refresh = sessions.refresh({ force: true });
      permissionEvent({ ...existing, updatedAt: 3, permissionMode: "full" });
      pending.resolve(response);
      await refresh;
      expect(sessions.state.result?.sessions).toEqual(response.sessions);
      expect(sessions.state.loading).toBe(false);
    } finally {
      pending.resolve(response);
      await refresh;
      sessions.dispose();
    }
  });

  it.each([
    { name: "an explicit mode", permissionMode: "full" as const },
    { name: "the default mode", permissionMode: undefined },
  ])("preserves $name without discarding a pending ordinary roster", async ({ permissionMode }) => {
    const existing = sessionRow("agent:main:edited", { label: "Original" });
    const removed = sessionRow("agent:main:removed");
    const added = sessionRow("agent:main:added", { label: "New member" });
    const response = sessionsResult(
      [{ ...existing, label: "Listed label", updatedAt: 2 }, added],
      2,
    );
    const pending = createDeferred<SessionsListResult>();
    const { sessions, permissionEvent, request } = harness(
      sessionsResult([existing, removed], 1),
      pending.promise,
    );
    let refresh: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      refresh = sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.loading).toBe(true);
      permissionEvent({ ...existing, updatedAt: 3, permissionMode });
      pending.resolve(response);
      await refresh;

      expect(sessions.state.loading).toBe(false);
      expect(sessions.state.error).toBeNull();
      expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
        existing.key,
        added.key,
      ]);
      expect(sessions.state.result?.sessions[0]).toMatchObject({ label: "Listed label" });
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe(permissionMode);
      if (permissionMode === undefined) {
        expect(sessions.state.result?.sessions[0]).not.toHaveProperty("permissionMode");
      }
      expect(sessions.state.result?.sessions[1]).toEqual(added);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve(response);
      await refresh;
      sessions.dispose();
    }
  });

  it("keeps the latest confirmed permission when an older independent list finishes last", async () => {
    const existing = sessionRow("agent:main:ordered");
    const oldResponse = sessionsResult([{ ...existing, label: "Older list label" }], 1);
    const confirmed = sessionRow(existing.key, { updatedAt: 4, permissionMode: "workspace" });
    const oldRead = createDeferred<SessionsListResult>();
    const { sessions, permissionEvent } = harness(
      sessionsResult([existing], 1),
      oldRead.promise,
      sessionsResult([confirmed], 4),
    );
    let first: Promise<SessionsListResult | null> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      first = sessions.list({ agentId: "main" });
      permissionEvent({ ...existing, updatedAt: 3, permissionMode: "full" });
      await sessions.refreshList(managedScope);
      expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.permissionMode).toBe(
        "workspace",
      );
      oldRead.resolve(oldResponse);
      const result = await first;

      expect(result?.sessions[0]).toMatchObject({
        key: existing.key,
        label: "Older list label",
        permissionMode: "workspace",
      });
      expect(sessions.listSnapshot(managedScope).result?.sessions[0]).toEqual(confirmed);
    } finally {
      oldRead.resolve(oldResponse);
      await first;
      sessions.dispose();
    }
  });

  it("rejects a late event older than a permission already confirmed by another held list", async () => {
    const initial = sessionRow("agent:main:cross-list");
    const confirmed = sessionRow(initial.key, {
      updatedAt: 5,
      permissionMode: "workspace",
    });
    const lateResponse = sessionsResult([{ ...confirmed, label: "Late independent result" }], 5);
    const olderRead = createDeferred<SessionsListResult>();
    const { sessions, permissionEvent } = harness(
      sessionsResult([initial], 1),
      olderRead.promise,
      sessionsResult([confirmed], 5),
    );
    let first: Promise<SessionsListResult | null> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      first = sessions.list({ agentId: "main" });
      permissionEvent({ ...initial, updatedAt: 3, permissionMode: "full" });
      await sessions.refreshList(managedScope);
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("full");
      expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.permissionMode).toBe(
        "workspace",
      );

      permissionEvent({ ...initial, updatedAt: 4, permissionMode: "guarded" });
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("workspace");
      olderRead.resolve(lateResponse);
      const result = await first;

      expect(result?.sessions).toEqual(lateResponse.sessions);
      expect(sessions.listSnapshot(managedScope).result?.sessions).toEqual([confirmed]);
      expect(sessions.state.loading).toBe(false);
    } finally {
      olderRead.resolve(lateResponse);
      await first;
      sessions.dispose();
    }
  });

  it("keeps raw global permission projections with their explicit agent", async () => {
    const main = sessionRow("global", { kind: "global", agentId: "main", sessionId: "shared-id" });
    const research = sessionRow("global", {
      kind: "global",
      agentId: "research",
      sessionId: "shared-id",
      label: "Research",
    });
    const mainRead = createDeferred<SessionsListResult>();
    const researchRead = createDeferred<SessionsListResult>();
    const { sessions, permissionEvent } = harness(
      sessionsResult([main], 1),
      mainRead.promise,
      researchRead.promise,
    );
    let mainList: Promise<SessionsListResult | null> | undefined;
    let researchList: Promise<SessionsListResult | null> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      mainList = sessions.list({ agentId: "main" });
      researchList = sessions.list({ agentId: "research" });
      permissionEvent({ ...main, updatedAt: 3, permissionMode: "full" }, "main");
      mainRead.resolve(sessionsResult([main], 1));
      researchRead.resolve(sessionsResult([research], 1));

      expect((await mainList)?.sessions[0]?.permissionMode).toBe("full");
      expect((await researchList)?.sessions[0]).toEqual(research);
    } finally {
      mainRead.resolve(sessionsResult([main], 1));
      researchRead.resolve(sessionsResult([research], 1));
      await Promise.all([mainList, researchList]);
      sessions.dispose();
    }
  });

  it("retires permission projections when a canonical list establishes a successor incarnation", async () => {
    const original = sessionRow("agent:main:recreated");
    const replacement = sessionRow(original.key, {
      sessionId: "replacement-generation",
      permissionMode: "workspace",
      updatedAt: 5,
    });
    const oldRead = createDeferred<SessionsListResult>();
    const { sessions, permissionEvent } = harness(
      sessionsResult([original], 1),
      oldRead.promise,
      sessionsResult([replacement], 5),
      sessionsResult([replacement], 6),
    );
    let first: Promise<SessionsListResult | null> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      first = sessions.list({ agentId: "main" });
      permissionEvent({ ...original, updatedAt: 3, permissionMode: "full" });
      await sessions.refreshList(managedScope);
      permissionEvent({ ...original, updatedAt: 99, permissionMode: "full" });
      oldRead.resolve(sessionsResult([original], 1));

      expect((await first)?.sessions).toEqual([]);
      expect(sessions.listSnapshot(managedScope).result?.sessions).toEqual([replacement]);
      expect((await sessions.list({ agentId: "main" }))?.sessions).toEqual([replacement]);
    } finally {
      oldRead.resolve(sessionsResult([original], 1));
      await first;
      sessions.dispose();
    }
  });

  it("binds accepted successor events to their incarnation before primary publication", async () => {
    const original = sessionRow("agent:main:successor-events", { sessionId: "old-generation" });
    const successor = sessionRow(original.key, {
      sessionId: "successor-generation",
      updatedAt: 3,
    });
    const response = sessionsResult(
      [{ ...successor, permissionMode: "workspace", updatedAt: 4, label: "Canonical successor" }],
      4,
    );
    const pending = createDeferred<SessionsListResult>();
    const { sessions, permissionEvent } = harness(
      sessionsResult([original], 1),
      sessionsResult([successor], 3),
      pending.promise,
    );
    let refresh: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      permissionEvent({ ...original, updatedAt: 2, permissionMode: "full" });
      await sessions.refreshList(managedScope);
      expect(sessions.state.result?.sessions[0]?.sessionId).toBe(original.sessionId);
      expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.sessionId).toBe(
        successor.sessionId,
      );

      permissionEvent({ ...successor, updatedAt: 4, permissionMode: "workspace" });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        sessionId: successor.sessionId,
        permissionMode: "workspace",
      });
      refresh = sessions.refresh({ agentId: "main", force: true });
      permissionEvent({ ...successor, updatedAt: 5, permissionMode: "full" });
      pending.resolve(response);
      await refresh;

      expect(sessions.state.result?.sessions[0]).toMatchObject({
        sessionId: successor.sessionId,
        permissionMode: "full",
        label: "Canonical successor",
      });
      expect(sessions.state.loading).toBe(false);
      permissionEvent({ ...original, updatedAt: 99, permissionMode: "guarded" });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        sessionId: successor.sessionId,
        permissionMode: "full",
      });
    } finally {
      pending.resolve(response);
      await refresh;
      sessions.dispose();
    }
  });

  it("does not give a rejected older permission event authority over a pending refresh", async () => {
    const current = sessionRow("agent:main:fresh", { updatedAt: 30, permissionMode: "full" });
    const response = sessionsResult(
      [{ ...current, updatedAt: 31, permissionMode: "workspace" }],
      31,
    );
    const pending = createDeferred<SessionsListResult>();
    const { sessions, permissionEvent } = harness(sessionsResult([current], 30), pending.promise);
    let refresh: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      refresh = sessions.refresh({ agentId: "main", force: true });
      permissionEvent({ ...current, updatedAt: 20, permissionMode: "guarded" });
      pending.resolve(response);
      await refresh;

      expect(sessions.state.result?.sessions).toEqual(response.sessions);
      expect(sessions.state.loading).toBe(false);
      expect(sessions.state.error).toBeNull();
    } finally {
      pending.resolve(response);
      await refresh;
      sessions.dispose();
    }
  });

  it.each([true, false])(
    "preserves a managed-only permission with primary availability %s",
    async (primaryAvailable) => {
      const main = sessionRow("agent:main:main");
      const research = sessionRow("agent:research:managed", { agentId: "research" });
      const scope = { ...managedScope, agentId: "research" };
      const pending = createDeferred<SessionsListResult>();
      const response = sessionsResult([{ ...research, label: "Refreshed managed label" }], 2);
      const { sessions, permissionEvent, request } = harness(
        primaryAvailable ? sessionsResult([main], 1) : new Error("Primary unavailable"),
        sessionsResult([research], 1),
        pending.promise,
      );
      let refresh: Promise<void> | undefined;
      try {
        await sessions.refresh({ agentId: "main", force: true });
        await sessions.refreshList(scope);
        refresh = sessions.refreshList({ ...scope, force: true });
        permissionEvent({ ...research, updatedAt: 3, permissionMode: "full" }, "research");
        pending.resolve(response);
        await refresh;

        expect(sessions.listSnapshot(scope).result?.sessions[0]).toMatchObject({
          key: research.key,
          permissionMode: "full",
          label: "Refreshed managed label",
        });
        expect(sessions.listSnapshot(scope).loading).toBe(false);
        expect(sessions.state.result?.sessions ?? null).toEqual(primaryAvailable ? [main] : null);
        expect(sessions.state.error).toBe(primaryAvailable ? null : "Primary unavailable");
        expect(request).toHaveBeenCalledTimes(3);
      } finally {
        pending.resolve(response);
        await refresh;
        sessions.dispose();
      }
    },
  );
});
