// The serving bundle may retire this document before reconnect admits it.
// Preserve the pending read-only reconciliation and its eventual notice across
// that reload; neither record authorizes starting another update.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { reloadControlUiIfStale } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { getSafeSessionStorage } from "../local-storage.ts";
import {
  UPDATE_HANDOFF_TIMEOUT_MS,
  type PendingUpdateReconciliation,
} from "./update-overlay-helpers.ts";

const UPDATE_NOTICE_KEY = "openclaw:control-ui:update:v1";

type UpdateInstallIdentity = { version: string | null; sha: string | null };
type UpdateNoticeScope = { gateway: string; profileId: string | null };
type VerifiedUpdateNotice = UpdateNoticeScope &
  UpdateInstallIdentity & {
    kind: "verified";
    deadlineAtMs: number;
  };
type UpdateNotice = (UpdateNoticeScope & PendingUpdateReconciliation) | VerifiedUpdateNotice;

export function writeUpdateNotice(notice: UpdateNotice | null): void {
  try {
    const storage = getSafeSessionStorage();
    if (notice === null) {
      storage?.removeItem(UPDATE_NOTICE_KEY);
    } else {
      storage?.setItem(UPDATE_NOTICE_KEY, JSON.stringify(notice));
    }
  } catch {
    // Denied storage must not prevent the current document reporting its result.
  }
}

function isUpdateNotice(notice: unknown, gateway: string): notice is UpdateNotice {
  if (
    !isRecord(notice) ||
    notice.gateway !== gateway ||
    (notice.profileId !== null && typeof notice.profileId !== "string") ||
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
    notice.kind === "verified"
      ? [notice.version, notice.sha]
      : [notice.expectedVersion, notice.expectedSha, notice.handoffId]
  ).every((value) => value === null || typeof value === "string");
}

export function readUpdateNotice(gateway: string): UpdateNotice | null {
  try {
    const raw = getSafeSessionStorage()?.getItem(UPDATE_NOTICE_KEY);
    const notice: unknown = raw && raw.length <= 4_096 ? JSON.parse(raw) : null;
    if (isUpdateNotice(notice, gateway)) {
      return notice;
    }
  } catch {
    // Invalid or inaccessible transient notices cannot resume reconciliation.
  }
  writeUpdateNotice(null);
  return null;
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

/** Records the outcome, then presents it here unless a reload will present it. */
export function announceVerifiedUpdateInstall(
  identity: UpdateInstallIdentity,
  scope: UpdateNoticeScope,
): void {
  writeUpdateNotice({
    ...identity,
    ...scope,
    kind: "verified",
    deadlineAtMs: Date.now() + UPDATE_HANDOFF_TIMEOUT_MS,
  });
  if (!reloadControlUiIfStale(identity)) {
    writeUpdateNotice(null);
    showToast({ message: formatUpdateSuccess(identity) });
  }
}

/** Presents a recorded install outcome once, then forgets it. */
export function announceRecordedUpdateSuccess(scope: UpdateNoticeScope | null): void {
  if (!scope) {
    writeUpdateNotice(null);
    return;
  }
  const notice = readUpdateNotice(scope.gateway);
  if (notice?.kind !== "verified") {
    return;
  }
  writeUpdateNotice(null);
  if (notice.profileId !== scope.profileId) {
    return;
  }
  showToast({ message: formatUpdateSuccess(notice) });
}
