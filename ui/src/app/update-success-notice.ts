// The serving bundle may retire this document before reconnect admits it.
// Preserve the pending read-only reconciliation and its eventual notice across
// that reload; neither record authorizes starting another update.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { reloadControlUiIfStale } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { generateUUID } from "../lib/uuid.ts";
import { getSafeSessionStorage } from "../local-storage.ts";
import {
  UPDATE_HANDOFF_TIMEOUT_MS,
  type PendingUpdateReconciliation,
} from "./update-overlay-helpers.ts";

const UPDATE_NOTICE_KEY = "openclaw:control-ui:update:v1";
const UPDATE_TRIAGE_RECEIPT_LIMIT = 32;
const UPDATE_NOTICE_LENGTH_LIMIT = 4_096;

type UpdateInstallIdentity = { version: string | null; sha: string | null };
type UpdateNoticeScope = { gateway: string; profileId: string | null };
type VerifiedUpdateNotice = UpdateNoticeScope &
  UpdateInstallIdentity & {
    kind: "verified";
    deadlineAtMs: number;
  };
type UpdateNotice = (UpdateNoticeScope & PendingUpdateReconciliation) | VerifiedUpdateNotice;
type StoredUpdateNotice =
  | (UpdateNoticeScope & Omit<PendingUpdateReconciliation, "requestId"> & { requestId?: string })
  | VerifiedUpdateNotice;

function isStoredUpdateNotice(notice: unknown, gateway: string): notice is StoredUpdateNotice {
  if (
    !isRecord(notice) ||
    notice.gateway !== gateway ||
    (notice.profileId !== null && typeof notice.profileId !== "string")
  ) {
    return false;
  }
  if (
    (notice.kind !== "verified" &&
      notice.kind !== "ambiguous" &&
      notice.kind !== "handoff" &&
      notice.kind !== "restart") ||
    typeof notice.deadlineAtMs !== "number" ||
    !Number.isFinite(notice.deadlineAtMs) ||
    notice.deadlineAtMs > Date.now() + UPDATE_HANDOFF_TIMEOUT_MS ||
    (notice.kind === "verified" && notice.deadlineAtMs <= Date.now())
  ) {
    return false;
  }
  return (
    (notice.kind === "verified" ||
      notice.record === undefined ||
      (isRecord(notice.record) &&
        (notice.record.id === null || typeof notice.record.id === "string") &&
        (notice.record.timestampMs === null ||
          (typeof notice.record.timestampMs === "number" &&
            Number.isFinite(notice.record.timestampMs))))) &&
    (notice.kind === "verified"
      ? [notice.version, notice.sha]
      : [notice.expectedVersion, notice.expectedSha, notice.handoffId]
    ).every((value) => value === null || typeof value === "string") &&
    (notice.kind === "verified" ||
      notice.requestId === undefined ||
      typeof notice.requestId === "string")
  );
}

function formatUpdateSuccess(identity: UpdateInstallIdentity): string {
  // A git install keeps its version across commits, so the commit is the only
  // fact that actually changed; package installs report no commit at all.
  const sha = identity.sha?.trim();
  if (sha) {
    return t("updates.succeededCommit", { sha: sha.slice(0, 7) });
  }
  const version = identity.version?.trim();
  return version ? t("updates.succeededVersion", { version }) : t("updates.succeeded");
}

export function createUpdateNoticeSession(gateway: string) {
  let notice: UpdateNotice | null = null;
  // Receipt identity includes both authority scopes. Keep no failure facts, and
  // bound this tab's history without replaying simply because scope changed.
  let triaged: string[] = [];
  const receiptKey = (scope: UpdateNoticeScope, attemptId: string) =>
    JSON.stringify([scope.gateway, scope.profileId, attemptId]);
  const lengthLimit = UPDATE_NOTICE_LENGTH_LIMIT * (UPDATE_TRIAGE_RECEIPT_LIMIT + 1);
  let storage = getSafeSessionStorage();
  try {
    const raw = storage?.getItem(UPDATE_NOTICE_KEY) ?? null;
    const saved: unknown = raw && raw.length <= lengthLimit ? JSON.parse(raw) : null;
    if (raw !== null && !isRecord(saved)) {
      storage = null;
    }
    if (isRecord(saved)) {
      const { triaged: savedReceipts, ...savedNotice } = saved;
      if (
        savedReceipts !== undefined &&
        (!Array.isArray(savedReceipts) || savedReceipts.some((key) => typeof key !== "string"))
      ) {
        storage = null;
      }
      if (isStoredUpdateNotice(savedNotice, gateway)) {
        // The outgoing bundle's flat v1 pending notice predates requestId.
        // Assign it once here, before persisting the same scoped handoff below.
        notice =
          savedNotice.kind === "verified"
            ? savedNotice
            : { ...savedNotice, requestId: savedNotice.requestId ?? generateUUID() };
      }
      if (Array.isArray(savedReceipts)) {
        triaged = savedReceipts
          .filter((key): key is string => typeof key === "string")
          .slice(-UPDATE_TRIAGE_RECEIPT_LIMIT);
      }
    }
  } catch {
    // Unreadable history cannot be overwritten or authorize another automatic turn.
    storage = null;
  }
  const write = (next: UpdateNotice | null, receipts = triaged): boolean => {
    notice = next;
    try {
      const raw = JSON.stringify({ ...notice, triaged: receipts });
      if (!storage || raw.length > lengthLimit) {
        return false;
      }
      if (!notice && receipts.length === 0) {
        storage.removeItem(UPDATE_NOTICE_KEY);
      } else {
        storage.setItem(UPDATE_NOTICE_KEY, raw);
      }
      triaged = receipts;
      return true;
    } catch {
      // Keep visible results, but only persisted receipts may authorize diagnosis.
      return false;
    }
  };
  write(notice);

  return {
    get notice() {
      return notice;
    },
    write,
    hasTriaged: (scope: UpdateNoticeScope, attemptId: string) =>
      triaged.includes(receiptKey(scope, attemptId)),
    recordTriage(scope: UpdateNoticeScope, attemptId: string) {
      return write(
        notice,
        [...triaged, receiptKey(scope, attemptId)].slice(-UPDATE_TRIAGE_RECEIPT_LIMIT),
      );
    },
    announceVerifiedInstall(identity: UpdateInstallIdentity, scope: UpdateNoticeScope) {
      write({
        ...identity,
        ...scope,
        kind: "verified",
        deadlineAtMs: Date.now() + UPDATE_HANDOFF_TIMEOUT_MS,
      });
      if (!reloadControlUiIfStale(identity)) {
        write(null);
        showToast({ message: formatUpdateSuccess(identity) });
      }
    },
    announceRecordedSuccess(scope: UpdateNoticeScope) {
      if (notice?.kind !== "verified") {
        return;
      }
      const verified = notice;
      write(null);
      if (isStoredUpdateNotice(verified, scope.gateway) && verified.profileId === scope.profileId) {
        showToast({ message: formatUpdateSuccess(verified) });
      }
    },
  };
}
