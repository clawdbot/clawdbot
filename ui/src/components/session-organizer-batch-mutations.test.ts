/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
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
  deleteSessionsBatch,
  stopCloudWorker,
} from "./session-organizer-operations.runtime.ts";

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
        params.methods === null ? {} : { methods: params.methods ?? ["sessions.patchMany"] },
      auth: { role: "operator", scopes: params.scopes ?? ["operator.write"] },
    },
  } as ApplicationGatewaySnapshot;
  const refreshReplacement = vi.fn(async () => undefined);
  const refreshTheme = vi.fn();
  const deleteMany = vi.fn(async () => ({ deleted: [], errors: [], preservedWorktrees: [] }));
  const deleteOne = vi.fn(async () => ({ deleted: true }));
  const scope = {
    epoch: 1,
    context: { agents: { state: { agentsList: null } }, theme: { refresh: refreshTheme } },
    gateway: { snapshot },
    sessions: {
      refreshReplacement,
      delete: deleteOne,
      deleteMany,
    } as unknown as SessionCapability,
    client,
    selectedAgentId: "main",
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
    host,
    pruneSidebarSessionEntry,
    publishSessionMutationError,
    refreshReplacement,
    refreshTheme,
    replaceCurrentSession,
    request,
    // Stands in for a reconnect or agent switch landing while a confirm is open.
    retireScope: () => {
      current = false;
    },
    scope,
  };
}

describe("patchSessionRows", () => {
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
      const requestCall = harness.request.mock.calls[0]!;
      expect(requestCall.slice(0, 2)).toEqual([
        "sessions.patchMany",
        {
          targets: [
            {
              key: rows[0]!.key,
              agentId: "main",
              expectedSessionId: rows[0]!.sessionId,
            },
          ],
          patch: { archived },
        },
      ]);
      expect(requestCall).toHaveLength(archived ? 3 : 2);
      expect(requestCall[2]).toEqual(archived ? { timeoutMs: 10 * 60_000 } : undefined);
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

type OperationsHarness = ReturnType<typeof createHarness>;

const destructiveHarness = {
  methods: ["sessions.delete", "sessions.reclaim"],
  scopes: ["operator.write", "operator.admin"],
};

function cloudWorkerRow(hasActiveRun: boolean): SidebarRecentSession {
  return {
    ...sessionRow(0),
    hasActiveRun,
    cloudWorkerStopAction: { method: "sessions.reclaim", requiredScope: "operator.admin" },
  } as SidebarRecentSession;
}

const destructiveOperations = [
  {
    name: "batch delete",
    run: (harness: OperationsHarness) =>
      deleteSessionsBatch(harness.host, [sessionRow(0), sessionRow(1)], harness.scope),
    mutation: (harness: OperationsHarness) => harness.deleteMany,
  },
  {
    name: "session delete",
    run: (harness: OperationsHarness) => deleteSession(harness.host, sessionRow(0), harness.scope),
    mutation: (harness: OperationsHarness) => harness.deleteOne,
  },
  {
    name: "cloud worker stop",
    run: (harness: OperationsHarness) =>
      stopCloudWorker(harness.host, cloudWorkerRow(false), harness.scope),
    mutation: (harness: OperationsHarness) => harness.request,
  },
] as const;

describe("session organizer destructive confirmations", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    patchSettings({ sessionDeleteConfirm: true });
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it("renders the localized batch-delete copy in-app and deletes once accepted", async () => {
    const harness = createHarness(destructiveHarness);
    const rows = [sessionRow(0), sessionRow(1)];

    const pending = deleteSessionsBatch(harness.host, rows, harness.scope);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Delete 2 sessions and their transcripts?",
    );
    answerConfirmDialog(actions, "confirm");
    await pending;

    expect(harness.deleteMany).toHaveBeenCalledWith([
      { key: rows[0]!.key, agentId: "main", deleteTranscript: true },
      { key: rows[1]!.key, agentId: "main", deleteTranscript: true },
    ]);
  });

  it.each(destructiveOperations)("sends no $name request when cancelled", async (operation) => {
    const harness = createHarness(destructiveHarness);

    const pending = operation.run(harness);
    answerConfirmDialog(await waitForConfirmDialogActions(), "cancel");
    await pending;

    expect(operation.mutation(harness)).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
  });

  it.each(destructiveOperations)(
    "abandons the $name when the connection is replaced while its confirm is open",
    async (operation) => {
      const harness = createHarness(destructiveHarness);

      const pending = operation.run(harness);
      const actions = await waitForConfirmDialogActions();
      harness.retireScope();
      answerConfirmDialog(actions, "confirm");
      await pending;

      expect(operation.mutation(harness)).not.toHaveBeenCalled();
    },
  );

  it("keeps a retired scope from navigating when the worktree prompt is cancelled", async () => {
    const harness = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });
    harness.deleteOne.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: { id: "wt-1", branch: "feature", path: "/tmp/worktree" },
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
  });

  it("skips the delete confirm entirely once the operator opted out", async () => {
    patchSettings({ sessionDeleteConfirm: false });
    const harness = createHarness(destructiveHarness);

    await deleteSession(harness.host, sessionRow(0), harness.scope, { offerSkip: true });

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(harness.deleteOne).toHaveBeenCalledOnce();
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
          worktreePreserved: { id: "wt-1", branch: "feature", path: "/tmp/worktree" },
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
