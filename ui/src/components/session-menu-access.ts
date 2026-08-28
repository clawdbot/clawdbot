import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { CloudWorkerStopAction } from "./cloud-worker-stop.ts";
import type { SessionMenuActionKind } from "./session-menu.ts";

type SessionMenuAccessRow = {
  key: string;
  sessionId?: string;
  archived?: boolean;
};

export function sessionMenuReasons(params: {
  snapshot: ApplicationGatewaySnapshot | undefined;
  session: SessionMenuAccessRow;
  batchRows?: readonly SessionMenuAccessRow[] | null;
  cloudWorkerStopAction?: CloudWorkerStopAction | null;
}): Partial<Record<SessionMenuActionKind, string>> {
  const { snapshot, session, batchRows = null, cloudWorkerStopAction } = params;
  const reason = (request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  }) => {
    const access = readSessionMethodAccess(snapshot, request);
    return access.allowed ? undefined : access.reason;
  };
  const patchReason = reason({
    method: "sessions.patch",
    params: { key: session.key, label: null },
  });
  const batchPatchReason = (patch: Record<string, unknown>) => {
    if (!batchRows) {
      return patchReason;
    }
    const access = readSessionMethodAccess(snapshot, {
      method: "sessions.patchMany",
      params: {
        targets: batchRows.map((row) => ({
          key: row.key,
          ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
        })),
        patch,
      },
    });
    if (access.allowed) {
      return undefined;
    }
    return access.cause === "method-unavailable" ? patchReason : access.reason;
  };
  const unreadReason = batchPatchReason({ unread: true });
  const categoryReason = batchPatchReason({ category: null });
  const lifecycleRows = batchRows ?? [session];
  const archiveReason = lifecycleRows.some((row) => !row.sessionId?.trim())
    ? "Session lifecycle action requires a durable session identity."
    : batchPatchReason({ archived: true });
  const groupReason = reason({
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
  const deleteReason = (batchRows ?? [session])
    .map((row) =>
      reason({
        method: "sessions.delete",
        params: {
          key: row.key,
          ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
          ...(row.archived ? { archivedOnly: true } : {}),
        },
      }),
    )
    .find((value): value is string => Boolean(value));
  const forkReason = batchRows
    ? undefined
    : reason({
        method: "sessions.create",
        params: { parentSessionKey: session.key, fork: true },
      });
  const cloudWorkerStopReason = cloudWorkerStopAction ? reason(cloudWorkerStopAction) : undefined;
  return {
    ...(patchReason
      ? {
          "toggle-pin": patchReason,
          rename: patchReason,
          "set-icon": patchReason,
        }
      : {}),
    ...(unreadReason ? { "toggle-unread": unreadReason } : {}),
    ...(categoryReason ? { "move-to-group": categoryReason } : {}),
    ...(archiveReason ? { "toggle-archived": archiveReason } : {}),
    ...(groupReason || categoryReason ? { "new-group": groupReason ?? categoryReason } : {}),
    ...(forkReason ? { fork: forkReason } : {}),
    ...(cloudWorkerStopReason ? { "stop-cloud-worker": cloudWorkerStopReason } : {}),
    ...(deleteReason ? { delete: deleteReason } : {}),
  };
}
