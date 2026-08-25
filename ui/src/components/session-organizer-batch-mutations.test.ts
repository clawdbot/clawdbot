/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { SessionDeleteBatchResult } from "../lib/sessions/session-capability.ts";
import { showToast } from "../lib/toast.ts";
import { SESSION_MUTATION_TEST_METHODS } from "../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { patchSessionRows } from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";
import {
  deleteSession,
  deleteSessionGroup,
  deleteSessionsBatch,
  patchSession,
  stopCloudWorker,
} from "./session-organizer-operations.runtime.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

function sessionRow(index: number): SidebarRecentSession {
  return {
    key: `agent:main:batch-${index}`,
    label: `Batch ${index}`,
    sessionId: `session-${index}`,
    pinned: index === 0 || index === 100,
  } as SidebarRecentSession;
}

function createHarness(
  params: {
    methods?: string[] | null;
    capabilities?: string[];
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
  // Mirrors SessionDataController's own controller: retiring the scope aborts
  // it so a dialog wired to `scope.signal` dismisses itself for real, and
  // renewing stands in for the next `beginSessionMutation()` after a reconnect.
  let abortController = new AbortController();
  const request = vi.fn(async (_method: string, rawParams?: unknown, _options?: unknown) => {
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
        params.methods === null
          ? {}
          : {
              methods: params.methods ?? [...SESSION_MUTATION_TEST_METHODS],
              capabilities: params.capabilities ?? [
                GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT,
              ],
            },
      auth: { role: "operator", scopes: params.scopes ?? ["operator.write"] },
    },
  } as ApplicationGatewaySnapshot;
  const patch = vi.fn(async (key: string) => ({ ok: true, key }));
  const refreshReplacement = vi.fn(async () => undefined);
  const refreshTheme = vi.fn();
  const deleteMany = vi.fn(
    async (): Promise<SessionDeleteBatchResult> => ({
      deleted: [],
      errors: [],
      preservedWorktrees: [],
    }),
  );
  const deleteOne = vi.fn(async () => ({ deleted: true }));
  const groupsDelete = vi.fn(async () => "completed" as const);
  const scope = {
    epoch: 1,
    context: { agents: { state: { agentsList: null } }, theme: { refresh: refreshTheme } },
    gateway: { snapshot },
    sessions: {
      patch,
      refreshReplacement,
      delete: deleteOne,
      deleteMany,
      groupsDelete,
    } as unknown as SessionCapability,
    client,
    selectedAgentId: "main",
    signal: abortController.signal,
  } as unknown as SidebarSessionMutationScope;
  const publishSessionMutationError = vi.fn();
  const pruneSidebarSessionEntry = vi.fn();
  const replaceCurrentSession = vi.fn();
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError,
      refreshSidebarSessions: vi.fn(),
    },
    sidebarSessionStatusFilter: () => "active",
    pruneSidebarSessionEntry,
    replaceCurrentSession,
  } as unknown as SessionOrganizerControllerHost;
  return {
    deleteMany,
    deleteOne,
    groupsDelete,
    host,
    patch,
    pruneSidebarSessionEntry,
    publishSessionMutationError,
    refreshReplacement,
    refreshTheme,
    replaceCurrentSession,
    request,
    // Stands in for a reconnect or agent switch landing while a confirm is open.
    retireScope: () => {
      current = false;
      abortController.abort();
    },
    // Stands in for the next beginSessionMutation() a reconnect issues.
    renewScope: () => {
      current = true;
      abortController = new AbortController();
      scope.signal = abortController.signal;
    },
    scope,
  };
}

describe("patchSessionRows", () => {
  it("identifies a single Mark as read action explicitly", async () => {
    const row = sessionRow(0);
    const harness = createHarness();

    await expect(patchSession(harness.host, row, { unread: false }, harness.scope)).resolves.toBe(
      "completed",
    );

    expect(harness.patch).toHaveBeenCalledWith(
      row.key,
      { unread: false },
      { agentId: "main", readIntent: "explicit" },
    );
  });

  it("preflights every lifecycle identity before dispatching the first chunk", async () => {
    const harness = createHarness();
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
    rows[100] = { ...rows[100]!, sessionId: undefined };

    await expect(
      patchSessionRows(harness.host, rows, { archived: false }, harness.scope),
    ).resolves.toBeNull();

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "Session lifecycle action requires a durable session identity.",
    );
  });

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
    expect(harness.request.mock.calls.map((call) => call[2])).toEqual([
      { timeoutMs: 10 * 60_000 },
      { timeoutMs: 10 * 60_000 },
    ]);
    expect(harness.request.mock.calls.map(([, params]) => params)).toEqual([
      {
        targets: rows.slice(0, 100).map((row) => ({
          key: row.key,
          agentId: "main",
          expectedSessionId: row.sessionId,
        })),
        patch: { archived: true, unread: false },
      },
      {
        targets: [
          {
            key: rows[100]!.key,
            agentId: "main",
            expectedSessionId: rows[100]!.sessionId,
          },
        ],
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

  it("identifies every batch Mark as read target explicitly", async () => {
    const rows = [sessionRow(0), sessionRow(1)];
    const harness = createHarness();

    await patchSessionRows(harness.host, rows, { unread: false }, harness.scope);

    expect(harness.request).toHaveBeenCalledWith("sessions.patchMany", {
      targets: rows.map((row) => ({
        key: row.key,
        agentId: "main",
        readIntent: "explicit",
      })),
      patch: { unread: false },
    });
  });

  it("uses the legacy batch read payload when the Gateway lacks the unread contract", async () => {
    const rows = [sessionRow(0), sessionRow(1)];
    const harness = createHarness({ capabilities: [] });

    await patchSessionRows(harness.host, rows, { unread: false }, harness.scope);

    expect(harness.request).toHaveBeenCalledWith("sessions.patchMany", {
      targets: rows.map((row) => ({ key: row.key, agentId: "main" })),
      patch: { unread: false },
    });
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
    "uses the supplied fallback when patchMany is not advertised with archived=%s",
    async (archived) => {
      const harness = createHarness({
        methods: ["sessions.patch"],
      });
      const rows = [sessionRow(0)];
      const fallbackRows = [sessionRow(1)];
      const fallback = vi.fn(async () => fallbackRows);

      await expect(
        patchSessionRows(harness.host, rows, { archived }, harness.scope, { fallback }),
      ).resolves.toBe(fallbackRows);

      expect(harness.request).not.toHaveBeenCalled();
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

  it("does not fallback when method metadata is missing", async () => {
    const harness = createHarness({ methods: null });
    const fallback = vi.fn(async () => [sessionRow(1)]);

    await expect(
      patchSessionRows(harness.host, [sessionRow(0)], { archived: true }, harness.scope, {
        fallback,
      }),
    ).resolves.toBeNull();

    expect(fallback).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledOnce();
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

type OperationsHarness = ReturnType<typeof createHarness>;

const destructiveHarness = {
  methods: ["sessions.delete", "sessions.reclaim", "sessions.groups.delete"],
  scopes: ["operator.write", "operator.admin"],
};

function cloudWorkerRow(hasActiveRun: boolean): SidebarRecentSession {
  return {
    ...sessionRow(0),
    hasActiveRun,
    cloudWorkerStopAction: {
      method: "sessions.reclaim",
      requiredScope: "operator.write",
      blocksActiveRun: true,
    },
  } as SidebarRecentSession;
}

const destructiveOperations = [
  {
    name: "batch delete",
    run: (harness: OperationsHarness) =>
      deleteSessionsBatch(harness.host, [sessionRow(0), sessionRow(1)], harness.scope),
    mutation: (harness: OperationsHarness) => harness.deleteMany,
    staleMessage: t("sessionsView.deleteSessionsStale", { count: "2" }),
  },
  {
    name: "session delete",
    run: (harness: OperationsHarness) => deleteSession(harness.host, sessionRow(0), harness.scope),
    mutation: (harness: OperationsHarness) => harness.deleteOne,
    staleMessage: t("sessionsView.deleteSessionStale", { session: sessionRow(0).label }),
  },
  {
    name: "cloud worker stop",
    run: (harness: OperationsHarness) =>
      stopCloudWorker(harness.host, cloudWorkerRow(false), harness.scope),
    mutation: (harness: OperationsHarness) => harness.request,
    staleMessage: t("sessionsView.stopCloudWorkerStale", { session: cloudWorkerRow(false).label }),
  },
  {
    name: "session-group delete",
    run: (harness: OperationsHarness) => deleteSessionGroup(harness.host, "Group A", harness.scope),
    mutation: (harness: OperationsHarness) => harness.groupsDelete,
    staleMessage: t("sessionsView.deleteGroupStale", { group: "Group A" }),
  },
] as const;

describe("session organizer destructive confirmations", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    vi.mocked(showToast).mockClear();
  });

  afterEach(() => {
    patchSettings({ sessionDeleteConfirm: true });
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it("renders the localized batch-delete copy in-app and deletes once accepted", async () => {
    const harness = createHarness(destructiveHarness);
    const rows = [sessionRow(0), sessionRow(1)];
    const retryError = `Session ${rows[0]!.key} changed before deletion. Retry.`;
    harness.deleteMany.mockResolvedValueOnce({
      deleted: [rows[1]!.key],
      errors: [retryError],
      preservedWorktrees: [
        {
          id: "wt-busy",
          branch: "openclaw/busy",
          path: "/worktrees/busy",
          reason: "busy",
        },
      ],
    });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    const pending = deleteSessionsBatch(harness.host, rows, harness.scope);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Delete 2 sessions and their transcripts?",
    );
    answerConfirmDialog(actions, "confirm");
    await pending;

    expect(harness.deleteMany).toHaveBeenCalledWith([
      {
        key: rows[0]!.key,
        agentId: "main",
        deleteTranscript: true,
        expectedSessionId: rows[0]!.sessionId,
      },
      {
        key: rows[1]!.key,
        agentId: "main",
        deleteTranscript: true,
        expectedSessionId: rows[1]!.sessionId,
      },
    ]);
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(harness.scope, retryError);
    expect(retryError).not.toContain("GatewayRequestError");
    expect(alertSpy).toHaveBeenCalledWith(
      "Managed Worktrees:\nopenclaw/busy — live run or cleanup active",
    );
    alertSpy.mockRestore();
  });

  it.each(destructiveOperations)("sends no $name request when cancelled", async (operation) => {
    const harness = createHarness(destructiveHarness);

    const pending = operation.run(harness);
    answerConfirmDialog(await waitForConfirmDialogActions(), "cancel");
    await pending;

    expect(operation.mutation(harness)).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
    // An ordinary cancel is expected UX and needs no announcement; only a
    // reconnect-driven abort earns the retry notice below.
    expect(showToast).not.toHaveBeenCalled();
  });

  it.each(destructiveOperations)(
    "aborts the $name confirm and releases the lock for a fresh one when the connection is replaced while it is open",
    async (operation) => {
      const harness = createHarness(destructiveHarness);

      const pending = operation.run(harness);
      await waitForConfirmDialogActions();
      harness.retireScope();
      await pending;

      expect(operation.mutation(harness)).not.toHaveBeenCalled();
      // The stale dialog must dismiss itself, not merely stop sending its request.
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      // The abort resolves the dialog to `false`, same as a user cancel, so the
      // operator needs a distinct, visible outcome or their lost intent reads
      // as a click that simply did nothing.
      expect(showToast).toHaveBeenCalledWith({ message: operation.staleMessage });

      // A fresh confirmation (the reconnect's own retry) must be able to open
      // immediately; a stale dialog holding the shared lock would block it.
      harness.renewScope();
      const reopened = operation.run(harness);
      const freshActions = await waitForConfirmDialogActions();
      answerConfirmDialog(freshActions, "confirm");
      await reopened;

      expect(operation.mutation(harness)).toHaveBeenCalledOnce();
    },
  );

  it("keeps a retired scope from navigating when the worktree prompt is cancelled", async () => {
    const harness = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });
    harness.deleteOne.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: {
        id: "wt-1",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "cleanup-failed",
      },
    } as never);
    const active = { ...sessionRow(0), active: true } as SidebarRecentSession;

    const pending = deleteSession(harness.host, active, harness.scope);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    const worktreeActions = await waitForConfirmDialogActions();
    harness.retireScope();
    answerConfirmDialog(worktreeActions, "cancel");
    await pending;

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.replaceCurrentSession).not.toHaveBeenCalled();
    // The session delete already landed; the worktree just stays put, same as
    // the no-access branch, so the operator learns where it went.
    expect(showToast).toHaveBeenCalledWith({
      message: "Managed Worktrees:\nfeature — cleanup failed",
    });
  });

  it("surfaces a forced worktree removal that could not create a snapshot", async () => {
    const harness = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });
    harness.deleteOne.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: {
        id: "wt-1",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "snapshot-failed",
      },
    } as never);
    harness.request.mockResolvedValueOnce({
      removed: true,
      snapshotError: "nested gitlink",
    } as never);

    const pending = deleteSession(harness.host, sessionRow(0), harness.scope);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    const worktreeActions = await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "OpenClaw could not create a safety snapshot",
    );
    answerConfirmDialog(worktreeActions, "confirm");
    await pending;

    expect(harness.request).toHaveBeenCalledWith("worktrees.remove", {
      id: "wt-1",
      force: true,
    });
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "nested gitlink",
    );
  });

  it("skips the delete confirm entirely once the operator opted out", async () => {
    patchSettings({ sessionDeleteConfirm: false });
    const harness = createHarness(destructiveHarness);

    await deleteSession(harness.host, sessionRow(0), harness.scope, { offerSkip: true });

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(harness.deleteOne).toHaveBeenCalledWith(sessionRow(0).key, {
      agentId: "main",
      deleteTranscript: true,
      expectedSessionId: sessionRow(0).sessionId,
    });
  });

  it("asks again after the preference is reset", async () => {
    patchSettings({ sessionDeleteConfirm: false });
    patchSettings({ sessionDeleteConfirm: true });
    const harness = createHarness(destructiveHarness);

    const pending = deleteSession(harness.host, sessionRow(0), harness.scope, {
      offerSkip: true,
    });
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await pending;

    expect(harness.deleteOne).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "cloud worker stop",
      run: (harness: OperationsHarness) =>
        stopCloudWorker(harness.host, cloudWorkerRow(false), harness.scope),
    },
    {
      name: "preserved worktree removal",
      run: (harness: OperationsHarness) => {
        harness.deleteOne.mockResolvedValueOnce({
          deleted: true,
          worktreePreserved: {
            id: "wt-1",
            branch: "feature",
            path: "/tmp/worktree",
            reason: "foreign-lock",
          },
        } as never);
        return deleteSession(harness.host, sessionRow(0), harness.scope);
      },
    },
  ])("never offers an opt-out on the $name confirm", async (operation) => {
    // Opting out of session deletes must not leak into the serious confirms.
    patchSettings({ sessionDeleteConfirm: false });
    const harness = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });

    const pending = operation.run(harness);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
    answerConfirmDialog(actions, "cancel");
    await pending;
  });

  it("refreshes the appearance settings view when the operator opts out", async () => {
    const harness = createHarness(destructiveHarness);

    const pending = deleteSession(harness.host, sessionRow(0), harness.scope, {
      offerSkip: true,
    });
    const actions = await waitForConfirmDialogActions();
    const skip = actions
      .closest("openclaw-modal-dialog")
      ?.querySelector<HTMLInputElement>('.exec-approval-skip input[type="checkbox"]');
    if (!skip) {
      throw new Error("expected the skip checkbox");
    }
    skip.checked = true;
    skip.dispatchEvent(new Event("change"));
    answerConfirmDialog(actions, "confirm");
    await pending;

    // A mounted Settings -> Appearance only rereads settings on this signal.
    expect(harness.refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().sessionDeleteConfirm).toBe(false);
  });

  it("offers no opt-out to callers that share this delete outside the sidebar", async () => {
    // The chat-pane header calls deleteSession too; the setting names the
    // sidebar, so an opted-out operator must still be asked here.
    patchSettings({ sessionDeleteConfirm: false });
    const harness = createHarness(destructiveHarness);

    const pending = deleteSession(harness.host, sessionRow(0), harness.scope);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
    answerConfirmDialog(actions, "confirm");
    await pending;

    expect(harness.deleteOne).toHaveBeenCalledOnce();
  });

  it("never opens the stop confirm for a reclaim target with an active run", async () => {
    const harness = createHarness(destructiveHarness);

    await stopCloudWorker(harness.host, cloudWorkerRow(true), harness.scope);

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(harness.request).not.toHaveBeenCalled();
  });
});
