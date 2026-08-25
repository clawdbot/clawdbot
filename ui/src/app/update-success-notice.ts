// A verified install whose bundle differs from this document reloads the page
// (`reloadControlUiIfStale`), which destroys any in-memory outcome. Record the
// result before that navigation so the reloaded document still tells the
// operator the update finished instead of coming back silently.
import { reloadControlUiIfStale } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { getSafeSessionStorage } from "../local-storage.ts";

const UPDATE_SUCCESS_NOTICE_KEY = "openclaw:control-ui:update-succeeded:v1";

type UpdateInstallIdentity = { version: string | null; sha: string | null };

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

function takeRecordedUpdateSuccess(): string | null {
  try {
    const storage = getSafeSessionStorage();
    const raw = storage?.getItem(UPDATE_SUCCESS_NOTICE_KEY) ?? null;
    storage?.removeItem(UPDATE_SUCCESS_NOTICE_KEY);
    return raw;
  } catch {
    return null;
  }
}

/** Records the outcome, then presents it here unless a reload will present it. */
export function announceVerifiedUpdateInstall(identity: UpdateInstallIdentity): void {
  try {
    getSafeSessionStorage()?.setItem(UPDATE_SUCCESS_NOTICE_KEY, JSON.stringify(identity));
  } catch {
    // Storage is best effort; a document that stays put still announces below.
  }
  if (!reloadControlUiIfStale(identity)) {
    takeRecordedUpdateSuccess();
    showToast({ message: formatUpdateSuccess(identity), variant: "success" });
  }
}

/** Presents a recorded install outcome once, then forgets it. */
export function announceRecordedUpdateSuccess(): void {
  const raw = takeRecordedUpdateSuccess();
  if (!raw) {
    return;
  }
  let identity: UpdateInstallIdentity;
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateInstallIdentity>;
    identity = {
      version: typeof parsed.version === "string" ? parsed.version : null,
      sha: typeof parsed.sha === "string" ? parsed.sha : null,
    };
  } catch {
    return;
  }
  showToast({ message: formatUpdateSuccess(identity), variant: "success" });
}
