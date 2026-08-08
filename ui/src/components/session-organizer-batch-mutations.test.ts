import { describe, expect, it, vi } from "vitest";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { patchSessionRows } from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

function sessionRow(index: number): SidebarRecentSession {
  return {
    key: `agent:main:batch-${index}`,
    pinned: index === 0 || index === 100,
  } as SidebarRecentSession;
}

function createHarness(
  params: {
    methods?: string[] | null;
    scopes?: string[];
    current?: boolean;
    staleAfterRequest?: number;
    requestFailure?: { at: number; error: unknown };
    failedKeys?: readonly string[];
    phase?: ApplicationGatewaySnapshot["phase"];
  } = {},
) {
  let current = params.current ?? true;
  let requestCount = 0;
  const request = vi.fn(async (_method: string, rawParams?: unknown) => {
    const patchParams = rawParams as SessionsPatchManyParams;
    const requestFailure = params.requestFailure;
    requestCount += 1;
    if (requestFailure && requestCount === requestFailure.at) {
      throw requestFailure.error;
    }
    const result = {
      outcomes: patchParams.targets.map((target) => {
        if (params.failedKeys?.includes(target.key)) {
          const error = { code: "INVALID_REQUEST" as const, message: `failed ${target.key}` };
          return target.agentId
            ? { ok: false as const, key: target.key, agentId: target.agentId, error }
            : { ok: false as const, key: target.key, error };
        }
        if (target.agentId) {
          return { ok: true as const, key: target.key, agentId: target.agentId };
        }
        return { ok: true as const, key: target.key };
      }),
    } satisfies SessionsPatchManyResult;
    if (requestCount === params.staleAfterRequest) {
      current = false;
    }
    return result;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: params.phase ?? "connected",
    hello: {
      features:
        params.methods === null ? {} : { methods: params.methods ?? ["sessions.patchMany"] },
      auth: { role: "operator", scopes: params.scopes ?? ["operator.write"] },
    },
  } as ApplicationGatewaySnapshot;
  const refreshReplacement = vi.fn(async () => undefined);
  const scope = {
    epoch: 1,
    context: {},
    gateway: { snapshot },
    sessions: { refreshReplacement } as unknown as SessionCapability,
    client,
    selectedAgentId: "main",
  } as SidebarSessionMutationScope;
  const publishSessionMutationError = vi.fn();
  const pruneSidebarSessionEntry = vi.fn();
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError,
      refreshSidebarSessions: vi.fn(),
    },
    sidebarSessionStatusFilter: () => "active",
    pruneSidebarSessionEntry,
  } as unknown as SessionOrganizerControllerHost;
  return {
    host,
    pruneSidebarSessionEntry,
    publishSessionMutationError,
    refreshReplacement,
    request,
    scope,
  };
}

describe("patchSessionRows", () => {
  it("dispatches 101 rows as ordered protocol-sized chunks and refreshes once", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
    const harness = createHarness();

    const archived = await patchSessionRows(
      harness.host,
      rows,
      { archived: true, unread: false },
      harness.scope,
    );

    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.request.mock.calls.map(([, params]) => params)).toEqual([
      {
        targets: rows.slice(0, 100).map((row) => ({ key: row.key, agentId: "main" })),
        patch: { archived: true, unread: false },
      },
      {
        targets: [{ key: rows[100]!.key, agentId: "main" }],
        patch: { archived: true, unread: false },
      },
    ]);
    expect(archived).toEqual(rows);
    expect(harness.pruneSidebarSessionEntry.mock.calls.map(([key]) => key)).toEqual([
      rows[0]!.key,
      rows[100]!.key,
    ]);
    expect(harness.refreshReplacement).toHaveBeenCalledOnce();
  });

  it("sends no requests or refresh when the mutation scope is already stale", async () => {
    const harness = createHarness({ current: false });

    await expect(
      patchSessionRows(harness.host, [sessionRow(0)], { archived: true }, harness.scope),
    ).resolves.toBeNull();

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).not.toHaveBeenCalled();
  });

  it("keeps ordered partial outcomes and prunes only successful archived rows", async () => {
    const rows = [sessionRow(0), sessionRow(1), sessionRow(2)];
    const harness = createHarness({ failedKeys: [rows[0]!.key, rows[2]!.key] });

    await expect(
      patchSessionRows(harness.host, rows, { archived: true }, harness.scope),
    ).resolves.toEqual([rows[1]]);

    expect(harness.pruneSidebarSessionEntry).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      `${rows[0]!.key}: failed ${rows[0]!.key}; ${rows[2]!.key}: failed ${rows[2]!.key}`,
    );
    expect(harness.refreshReplacement).toHaveBeenCalledOnce();
  });

  it("stops before a later chunk when the mutation scope becomes stale", async () => {
    const harness = createHarness({ staleAfterRequest: 1 });
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));

    await expect(
      patchSessionRows(harness.host, rows, { archived: true }, harness.scope),
    ).resolves.toBeNull();

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.refreshReplacement).not.toHaveBeenCalled();
  });

  it("uses the supplied fallback when the method is unavailable", async () => {
    const harness = createHarness({ methods: [] });
    const fallbackRows = [sessionRow(1)];
    const fallback = vi.fn(async () => fallbackRows);

    await expect(
      patchSessionRows(harness.host, [sessionRow(0)], { archived: true }, harness.scope, {
        fallback,
      }),
    ).resolves.toBe(fallbackRows);

    expect(fallback).toHaveBeenCalledOnce();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the supplied fallback for a metadata-less legacy rejection with archived=%s",
    async (archived) => {
      const rejection = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: sessions.patchMany",
      });
      const harness = createHarness({
        methods: null,
        requestFailure: { at: 1, error: rejection },
      });
      const rows = [sessionRow(0)];
      const fallbackRows = [sessionRow(1)];
      const fallback = vi.fn(async () => fallbackRows);

      await expect(
        patchSessionRows(harness.host, rows, { archived }, harness.scope, { fallback }),
      ).resolves.toBe(fallbackRows);

      expect(harness.request).toHaveBeenCalledOnce();
      expect(harness.request).toHaveBeenCalledWith("sessions.patchMany", {
        targets: [{ key: rows[0]!.key, agentId: "main" }],
        patch: { archived },
      });
      expect(fallback).toHaveBeenCalledOnce();
      expect(harness.refreshReplacement).not.toHaveBeenCalled();
      expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
    },
  );

  it("does not fallback for an unrelated INVALID_REQUEST", async () => {
    const rejection = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "invalid archive request",
    });
    const harness = createHarness({
      methods: null,
      requestFailure: { at: 1, error: rejection },
    });
    const fallback = vi.fn(async () => [sessionRow(1)]);

    await expect(
      patchSessionRows(harness.host, [sessionRow(0)], { archived: true }, harness.scope, {
        fallback,
      }),
    ).resolves.toBeNull();

    expect(harness.request).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(harness.scope, rejection);
  });

  it("does not fallback for transport unavailability", async () => {
    const rejection = new GatewayRequestError({ code: "UNAVAILABLE", message: "disconnected" });
    const harness = createHarness({
      methods: null,
      requestFailure: { at: 1, error: rejection },
    });
    const fallback = vi.fn(async () => [sessionRow(1)]);

    await expect(
      patchSessionRows(harness.host, [sessionRow(0)], { unread: true }, harness.scope, {
        fallback,
      }),
    ).resolves.toBeNull();

    expect(fallback).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(harness.scope, rejection);
  });

  it("does not fallback while disconnected", async () => {
    const harness = createHarness({ phase: "stopped" });
    const fallback = vi.fn(async () => [sessionRow(1)]);

    await expect(
      patchSessionRows(harness.host, [sessionRow(0)], { category: "Projects" }, harness.scope, {
        fallback,
      }),
    ).resolves.toBeNull();

    expect(fallback).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "Connect to the Gateway to change sessions.",
    );
  });

  it("does not fallback after an earlier chunk succeeds", async () => {
    const rejection = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "unknown method: sessions.patchMany",
    });
    const harness = createHarness({ requestFailure: { at: 2, error: rejection } });
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
    const fallback = vi.fn(async () => [sessionRow(1)]);

    await expect(
      patchSessionRows(harness.host, rows, { archived: true }, harness.scope, { fallback }),
    ).resolves.toEqual(rows.slice(0, 100));

    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).toHaveBeenCalledOnce();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "unknown method: sessions.patchMany",
    );
  });

  it("does not fallback when operator.write is missing", async () => {
    const harness = createHarness({ scopes: ["operator.read"] });
    const fallback = vi.fn(async () => [sessionRow(1)]);

    await expect(
      patchSessionRows(harness.host, [sessionRow(0)], { archived: true }, harness.scope, {
        fallback,
      }),
    ).resolves.toBeNull();

    expect(fallback).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "This action requires operator.write access.",
    );
  });
});
