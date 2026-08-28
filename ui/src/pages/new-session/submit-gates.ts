// New-session submit gate table: the single owner of every reason submission
// can be blocked. canSubmit, the Start tooltip, and blocked-Enter notices all
// derive from this walk, so a gate cannot block silently.
import { t } from "../../i18n/index.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionPlacementTarget } from "../../lib/sessions/session-placement-recovery.ts";
import * as catalog from "./catalog-target.ts";
import { isWorktreeNameValid } from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionSnapshot } from "./draft-submission-contract.ts";
import type {
  PendingSessionPlacementRecoveryState,
  SubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";

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
  | "placement-recovery"
  | "agents"
  | "agent-not-allowed"
  | "device"
  | "device-runtime"
  | "cloud"
  | "worktree-unavailable"
  | "worktree-name"
  | "terminal-capabilities"
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

export function resolveCloudPlacementDisabledReason(place: DraftPlaceState): string | undefined {
  const runtimeReason = place.modelControl.cloudRuntimeUnsupportedReason();
  if (runtimeReason) {
    return runtimeReason;
  }
  if (place.repository.kind === "checking") {
    return t("newSession.checkingGit");
  }
  if (place.repository.kind === "unavailable" && !place.worktreeAvailable()) {
    return t("newSession.gitCheckUnavailable");
  }
  return place.worktreeAvailable() ? undefined : t("newSession.cloudRequiresWorktree");
}

/** Facts the gate walk reads from DraftSubmissionFlow, kept read-only. */
type SubmitGateHost = {
  readonly gatewayState: DraftGatewayState;
  readonly placeState: DraftPlaceState;
  readonly pendingPlacement: PendingSessionPlacementRecoveryState;
  readonly submitting: boolean;
  readonly message: string;
  readonly submissionOutcomeUnknown: SubmissionOutcomeReason | null;
  readonly pendingAttachmentReads: number;
  readonly hasDraftAttachments: boolean;
  readonly hasCapabilityOverrides: boolean;
  submissionSnapshot(): DraftSubmissionSnapshot;
  requiresModelSetup(): boolean;
  submissionAccess(): SessionMethodAccess;
  terminalStartAccess(): SessionMethodAccess;
  placementTargetForSubmission(): SessionPlacementTarget | null;
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
  const pendingPlacementActive = Boolean(host.pendingPlacement.sessionKey);
  if (host.submitting) {
    return { gate: "submitting" };
  }
  if (
    gateway.preferenceLoading ||
    place.modelControl.isRestoringPreference() ||
    !place.placementPreferenceReady
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
  if (!pendingPlacementActive && host.submissionOutcomeUnknown) {
    return {
      gate: "outcome-unknown",
      reason: t(
        host.submissionOutcomeUnknown === "gateway-changed"
          ? "newSession.createOutcomeUnknown"
          : "newSession.placementSetupInterrupted",
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
  if (kind === "terminal" && host.hasCapabilityOverrides) {
    return {
      gate: "terminal-capabilities",
      reason: t("newSession.terminalCapabilityOverridesUnsupported"),
    };
  }
  if (place.folderSubmissionBlocked()) {
    return { gate: "folder", reason: t("newSession.checkingPlace") };
  }
  if (pendingPlacementActive) {
    const retryReady = Boolean(
      host.pendingPlacement.retryAllowed &&
      client.recoveryScopeReady &&
      host.placementTargetForSubmission() &&
      host.pendingPlacement.agentId &&
      host.pendingPlacement.gatewayUrl === connection.connection.gatewayUrl &&
      host.pendingPlacement.recoveryScope === client.recoveryScope,
    );
    // Recovery retries own the remaining draft state; the place gates
    // below intentionally do not apply to a restored placement draft.
    return retryReady
      ? emptyDraftBlock(host, kind, pendingPlacementActive)
      : { gate: "placement-recovery", reason: t("newSession.placementNotReady") };
  }
  if (place.agents().length === 0) {
    return { gate: "agents", reason: t("newSession.agentsUnavailable") };
  }
  if (!catalog.allowsSelectedAgent(snapshot.data, place.selectedAgent())) {
    return { gate: "agent-not-allowed", reason: t("newSession.catalogUnavailable") };
  }
  if (!place.devicePlacementReady()) {
    return {
      gate: "device",
      reason: place.devicePlacementDisabledReason() ?? t("newSession.nodeUnavailable"),
    };
  }
  const deviceRuntimeUnsupportedReason = place.modelControl.devicePlacementUnsupportedReason();
  if ((place.deviceId || place.autoDevice) && deviceRuntimeUnsupportedReason) {
    return { gate: "device-runtime", reason: deviceRuntimeUnsupportedReason };
  }
  const placementTarget = host.placementTargetForSubmission();
  if (
    placementTarget &&
    (!client.recoveryScope || !client.recoveryScopeReady || gateway.cloudProfilesPending)
  ) {
    return { gate: "placement-recovery", reason: t("newSession.placementNotReady") };
  }
  const cloudProfileId = placementTarget?.kind === "profile" ? placementTarget.profileId : "";
  if (
    cloudProfileId &&
    (!gateway.cloudProfilesReady ||
      !place.worktree ||
      !gateway.cloudProfiles.some((profile) => profile.id === cloudProfileId) ||
      Boolean(host.cloudRuntimeUnsupportedReason()))
  ) {
    const reason =
      host.cloudDisabledReason() ??
      (place.worktree ? t("newSession.placementNotReady") : t("newSession.cloudRequiresWorktree"));
    return { gate: "cloud", reason };
  }
  // Remote placements force a managed worktree; this gate owns repository readiness for both.
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
  return emptyDraftBlock(host, kind, pendingPlacementActive);
}

// Last so an empty draft never masks a reasoned gate in the tooltip.
function emptyDraftBlock(
  host: SubmitGateHost,
  kind: "session" | "terminal",
  pendingPlacementActive: boolean,
): NewSessionSubmitBlock | undefined {
  if (kind !== "session") {
    return undefined;
  }
  const message = pendingPlacementActive ? host.pendingPlacement.message : host.message.trim();
  const hasAttachments = pendingPlacementActive
    ? Boolean(host.pendingPlacement.attachments?.length)
    : host.hasDraftAttachments;
  return message || hasAttachments ? undefined : { gate: "empty-draft" };
}
