// New-session submit gate table: the single owner of every reason submission
// can be blocked. canSubmit, the Start tooltip, and blocked-Enter notices all
// derive from this walk, so a gate cannot block silently.
import { t } from "../../i18n/index.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import * as catalog from "./catalog-target.ts";
import type { PendingCloudRecoveryState, SubmissionOutcomeReason } from "./cloud-recovery-state.ts";
import { isWorktreeNameValid } from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionSnapshot } from "./draft-submission-contract.ts";

// Silent gates are the only submit blocks allowed to omit a visible reason:
// the busy Start button and an empty draft already explain themselves. Every
// other gate must carry a reason at the type level, so a new gate cannot
// silently eat an Enter press again.
type SilentSubmitGate = "submitting" | "empty-draft";
type ReasonedSubmitGate =
  | "preference-restore"
  | "model-setup"
  | "route-pending"
  | "model-unavailable"
  | "attachment-reads"
  | "outcome-unknown"
  | "disconnected"
  | "access"
  | "folder"
  | "cloud-recovery"
  | "agents"
  | "agent-not-allowed"
  | "node"
  | "cloud"
  | "worktree-unavailable"
  | "worktree-name"
  | "terminal-folder";
export type NewSessionSubmitBlock =
  | { gate: SilentSubmitGate; reason?: undefined }
  | { gate: ReasonedSubmitGate; reason: string };

// These gates already render a persistent callout on the page; a blocked
// submit attempt must not duplicate that text as a second notice.
export const PAGE_RENDERED_GATES: ReadonlySet<string> = new Set([
  "outcome-unknown",
  "worktree-name",
]);

/** Facts the gate walk reads from DraftSubmissionFlow, kept read-only. */
type SubmitGateHost = {
  readonly gatewayState: DraftGatewayState;
  readonly placeState: DraftPlaceState;
  readonly pendingCloud: PendingCloudRecoveryState;
  readonly submitting: boolean;
  readonly message: string;
  readonly submissionOutcomeUnknown: SubmissionOutcomeReason | null;
  readonly pendingAttachmentReads: number;
  readonly hasDraftAttachments: boolean;
  submissionSnapshot(): DraftSubmissionSnapshot;
  requiresModelSetup(): boolean;
  submissionAccess(): SessionMethodAccess;
  terminalStartAccess(): SessionMethodAccess;
  cloudProfileForSubmission(): string;
  cloudDisabledReason(): string | undefined;
  cloudRuntimeUnsupportedReason(): string | undefined;
};

export function resolveNewSessionSubmitBlock(
  host: SubmitGateHost,
  kind: "session" | "terminal",
): NewSessionSubmitBlock | undefined {
  const gateway = host.gatewayState;
  const place = host.placeState;
  const snapshot = host.submissionSnapshot();
  const pendingCloudActive = Boolean(host.pendingCloud.sessionKey);
  if (host.submitting) {
    return { gate: "submitting" };
  }
  if (
    gateway.preferenceLoading ||
    place.modelControl.isRestoringPreference() ||
    !place.worktreePreferenceReady
  ) {
    return { gate: "preference-restore", reason: t("newSession.restoringPreferences") };
  }
  if (host.requiresModelSetup()) {
    return { gate: "model-setup", reason: t("modelSetup.required.title") };
  }
  if (catalog.isRoutePending(snapshot.data, snapshot.context?.sessions)) {
    return { gate: "route-pending", reason: t("newSession.catalogUnavailable") };
  }
  if (place.modelControl.isModelUnavailable(place.selectedAgent())) {
    return {
      gate: "model-unavailable",
      reason: `${t("modelSetup.failure.auth")}. ${t("modelSetup.failureGuidance.auth")}`,
    };
  }
  if (host.pendingAttachmentReads > 0) {
    return { gate: "attachment-reads", reason: t("newSession.readingAttachment") };
  }
  if (!pendingCloudActive && host.submissionOutcomeUnknown) {
    return {
      gate: "outcome-unknown",
      reason: t(
        host.submissionOutcomeUnknown === "gateway-changed"
          ? "newSession.createOutcomeUnknown"
          : "newSession.cloudSetupInterrupted",
      ),
    };
  }
  const connection = snapshot.context?.gateway;
  const client =
    connection?.snapshot.phase === "connected" ? (connection.snapshot.client ?? null) : null;
  if (!connection || !client) {
    // Same string readSessionMethodAccess reports for its disconnected
    // cause; checked here so the gates below can rely on a live client.
    return { gate: "disconnected", reason: t("sessionsView.actionRequiresConnection") };
  }
  const access = kind === "terminal" ? host.terminalStartAccess() : host.submissionAccess();
  if (!access.allowed) {
    return { gate: "access", reason: access.reason };
  }
  if (place.folderSubmissionBlocked()) {
    return { gate: "folder", reason: t("newSession.checkingPlace") };
  }
  if (pendingCloudActive) {
    const retryReady = Boolean(
      host.pendingCloud.retryAllowed &&
      client.recoveryScopeReady &&
      host.cloudProfileForSubmission() &&
      host.pendingCloud.agentId &&
      host.pendingCloud.gatewayUrl === connection.connection.gatewayUrl &&
      host.pendingCloud.recoveryScope === client.recoveryScope &&
      place.isAdmin(),
    );
    // Recovery retries own the remaining draft state; the place gates
    // below intentionally do not apply to a restored cloud draft.
    return retryReady
      ? emptyDraftBlock(host, kind, pendingCloudActive)
      : { gate: "cloud-recovery", reason: t("newSession.cloudNotReady") };
  }
  if (place.agents().length === 0) {
    return { gate: "agents", reason: t("newSession.agentsUnavailable") };
  }
  if (!catalog.allowsSelectedAgent(snapshot.data, place.selectedAgent())) {
    return { gate: "agent-not-allowed", reason: t("newSession.catalogUnavailable") };
  }
  if (!place.execNodeReady()) {
    return { gate: "node", reason: t("newSession.nodeUnavailable") };
  }
  const cloudProfileId = host.cloudProfileForSubmission();
  if (
    cloudProfileId &&
    (!place.isAdmin() ||
      !client.recoveryScope ||
      !client.recoveryScopeReady ||
      !gateway.cloudProfilesReady ||
      gateway.cloudProfilesPending ||
      !place.worktree ||
      !gateway.cloudProfiles.some((profile) => profile.id === cloudProfileId) ||
      Boolean(host.cloudRuntimeUnsupportedReason()))
  ) {
    const reason =
      host.cloudDisabledReason() ??
      (place.worktree ? t("newSession.cloudNotReady") : t("newSession.cloudRequiresWorktree"));
    return { gate: "cloud", reason };
  }
  // worktreeAvailable() is already false when an exec node is selected, so
  // this single gate also covers the node+worktree combination.
  if (place.worktree && !place.worktreeAvailable()) {
    return {
      gate: "worktree-unavailable",
      reason:
        place.repository.kind === "checking"
          ? t("newSession.checkingGit")
          : t("newSession.worktreeUnavailable"),
    };
  }
  if (place.worktree && !isWorktreeNameValid(place.worktreeName)) {
    return { gate: "worktree-name", reason: t("newSession.worktreeNameInvalid") };
  }
  if (kind === "terminal" && !(place.folder.trim() || place.workspacePath())) {
    return { gate: "terminal-folder", reason: t("newSession.terminalNeedsFolder") };
  }
  return emptyDraftBlock(host, kind, pendingCloudActive);
}

// Last so an empty draft never masks a reasoned gate in the tooltip.
function emptyDraftBlock(
  host: SubmitGateHost,
  kind: "session" | "terminal",
  pendingCloudActive: boolean,
): NewSessionSubmitBlock | undefined {
  if (kind !== "session") {
    return undefined;
  }
  const message = pendingCloudActive ? host.pendingCloud.message : host.message.trim();
  const hasAttachments = pendingCloudActive
    ? Boolean(host.pendingCloud.attachments?.length)
    : host.hasDraftAttachments;
  return message || hasAttachments ? undefined : { gate: "empty-draft" };
}
