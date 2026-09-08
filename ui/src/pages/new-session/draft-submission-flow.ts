import type { ProjectsAddResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  autoPromptNotificationsOnSend,
  hasActiveNotificationPromptGesture,
  shouldAutoPromptNotificationsOnSend,
} from "../../app/notifications-auto-prompt.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { trimHumanMentions, updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { SessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import { deleteSessionPlacementDraft } from "../../lib/sessions/session-placement-startup.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "../chat/composer-persistence.ts";
import { buildInitialChatSubmission, buildLocalUserMessage } from "../chat/user-message-content.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { prepareBackgroundSessionCompletion } from "./background-session-notice.ts";
import { NewSessionCapabilityController } from "./capability-controller.ts";
import * as catalog from "./catalog-target.ts";
import { NewSessionComposerTextareaController } from "./composer.ts";
import type { DraftSessionCreateOverrides, NewSessionVisibility } from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import {
  projectDraftSessionPlacementRecovery,
  resolveDraftSessionPlacement,
} from "./draft-session-placement.ts";
import { DraftSessionStartup, type DraftStartupResumption } from "./draft-session-startup.ts";
import type {
  DraftSubmissionCallbacks,
  DraftSubmissionSnapshot,
} from "./draft-submission-contract.ts";
import { NewSessionPermissionSelection } from "./permission-selection.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import {
  PendingSessionPlacementRecoveryState,
  type SubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";
import {
  PAGE_RENDERED_GATES,
  readNewSessionSubmissionAccess,
  requiresNewSessionModelSetup,
  resolveCloudPlacementDisabledReason,
  resolveNewSessionSubmitBlock,
  type NewSessionSubmitBlock,
} from "./submit-gates.ts";
import { startNewSessionInTerminal } from "./terminal-start.ts";

export class DraftSubmissionFlow {
  private visibilityValue: NewSessionVisibility = "normal";
  private messageValue = "";
  private mentionsValue: readonly HumanMention[] = [];
  private activeSubmission: { message: ReturnType<typeof buildLocalUserMessage> } | null = null;
  private blockedSubmitGate: string | null = null;
  submissionOutcomeUnknown: SubmissionOutcomeReason | null = null;
  private readonly startedSession = new StartedSessionNavigation();
  error: string | null = null;
  private submitRequestToken = 0;
  private readonly sessionStartup: DraftSessionStartup;
  readonly pendingPlacement = new PendingSessionPlacementRecoveryState();
  readonly attachmentDraft: NewSessionAttachmentDraft;
  readonly composerTextarea = new NewSessionComposerTextareaController();
  readonly permission = new NewSessionPermissionSelection(() => this.callbacks.requestUpdate());
  readonly draftPersistence: NewSessionDraftPersistence;
  readonly capabilities: NewSessionCapabilityController;

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly place: DraftPlaceState,
    private readonly read: () => DraftSubmissionSnapshot,
    private readonly callbacks: DraftSubmissionCallbacks,
  ) {
    this.capabilities = new NewSessionCapabilityController(callbacks.requestUpdate);
    this.capabilities.setMutationCallback(() => (this.startedSession.current = null));
    this.permission.setMutationCallback(() => (this.startedSession.current = null));
    this.sessionStartup = new DraftSessionStartup(gateway);
    this.draftPersistence = new NewSessionDraftPersistence(
      () => ({
        message: this.messageValue,
        mentions: this.mentionsValue,
        attachments: this.attachmentDraft.attachments,
        incognito: this.visibilityValue === "incognito",
      }),
      (message, attachments, resetVisibility, mentions) => {
        this.restoreDraftState({
          message,
          mentions,
          attachments,
          visibility: resetVisibility ? "normal" : this.visibilityValue,
        });
      },
      () => this.setError(CHAT_COMPOSER_DRAFT_STORAGE_ERROR),
    );
    this.attachmentDraft = new NewSessionAttachmentDraft(callbacks.requestUpdate, () => {
      this.startedSession.current = null;
      this.draftPersistence.noteUserMutation();
    });
  }

  get visibility(): NewSessionVisibility {
    return this.visibilityValue;
  }

  get message(): string {
    return this.messageValue;
  }

  get mentions(): readonly HumanMention[] {
    return this.mentionsValue;
  }

  get submitting(): boolean {
    return this.activeSubmission !== null || this.sessionStartup.active;
  }

  get pendingMessage() {
    return this.activeSubmission?.message ?? null;
  }

  resumeInterruptedSubmission() {
    const startup = this.sessionStartup.resume();
    if (startup.kind === "resume") {
      void this.submit(startup);
    } else if (startup.kind !== "wait") {
      this.activeSubmission = null;
      this.submissionOutcomeUnknown = "gateway-changed";
      this.callbacks.requestUpdate();
    }
  }

  setMessage(message: string, mentions?: readonly HumanMention[]) {
    this.startedSession.current = null;
    this.mentionsValue =
      mentions ?? updateHumanMentions(this.messageValue, message, this.mentionsValue);
    this.messageValue = message;
    this.draftPersistence.noteUserMutation();
    this.callbacks.requestUpdate();
  }

  restoreMessage(message: string, mentions: readonly HumanMention[] = []) {
    this.draftPersistence.noteDraftReplaced();
    this.messageValue = message;
    this.mentionsValue = mentions;
    this.callbacks.requestUpdate();
  }

  restoreDraftState(state: {
    message: string;
    mentions?: readonly HumanMention[];
    attachments: ChatAttachment[];
    visibility: NewSessionVisibility;
    toolOverrides?: NewSessionCapabilityController["toolOverrides"];
    permissionMode?: SessionCreateParams["permissionMode"];
  }) {
    this.draftPersistence.noteDraftReplaced();
    this.messageValue = state.message;
    this.mentionsValue = state.mentions ?? [];
    this.visibilityValue = state.visibility;
    this.capabilities.restoreToolOverrides(state.toolOverrides);
    if ("permissionMode" in state) {
      this.permission.restore(state.permissionMode);
    }
    this.attachmentDraft.restore(state.attachments);
  }

  setVisibility(visibility: NewSessionVisibility) {
    this.startedSession.current = null;
    const wasIncognito = this.visibilityValue === "incognito";
    const publish = this.callbacks.requestUpdate;
    this.visibilityValue = visibility;
    this.draftPersistence.transitionIncognito(wasIncognito, visibility === "incognito", publish);
  }

  setError(error: string | null) {
    if (error !== null || this.error === t("newSession.cloudRecoveryUnavailable")) {
      this.error = error;
    }
    this.callbacks.requestUpdate();
  }

  clearError() {
    this.error = null;
    this.callbacks.requestUpdate();
  }

  clearErrorIf(error: string) {
    if (this.error === error) {
      this.clearError();
    }
  }

  markPendingPlacementUnavailable(outcome: SubmissionOutcomeReason) {
    this.pendingPlacement.retryAllowed = false;
    this.submissionOutcomeUnknown = outcome;
    this.callbacks.requestUpdate();
  }

  /** A submit was attempted (Enter or Start click) while a gate blocked it. */
  noteBlockedSubmitAttempt() {
    this.blockedSubmitGate = this.submitBlock()?.gate ?? null;
    this.callbacks.requestUpdate();
  }

  /** Attempt-bound reason that retires when its transient gate lifts. */
  blockedSubmitNotice(): string | undefined {
    const block = this.blockedSubmitGate ? this.submitBlock() : undefined;
    return block?.gate === this.blockedSubmitGate && !PAGE_RENDERED_GATES.has(block.gate)
      ? block.reason
      : undefined;
  }

  private buildDraftSessionCreateParams(options: DraftSessionCreateOverrides = {}) {
    return this.place.buildSessionCreateParams({
      ...options,
      message: options.message ?? "",
      toolOverrides: this.capabilities.toolOverrides,
      permissionMode: this.permission.value,
      visibility: options.visibility ?? this.visibilityValue,
      catalogId: this.read().data?.catalogId,
      category: this.gateway.resolvedGroupCategory(),
    });
  }

  submissionAccess(
    createParams: Record<string, unknown> = this.pendingPlacement.createParams ??
      this.buildDraftSessionCreateParams(),
  ): SessionMethodAccess {
    return readNewSessionSubmissionAccess({
      gateway: this.read().context?.gateway.snapshot,
      place: this.place,
      pendingPlacement: this.pendingPlacement,
      hasInitialTurn: Boolean(this.messageValue.trim() || this.attachmentDraft.attachments.length),
      createParams,
    });
  }

  submitDisabledReason(): string | undefined {
    return this.submitBlock()?.reason;
  }

  incognitoDisabledReason(): string | undefined {
    const access = readSessionMethodAccess(this.read().context?.gateway.snapshot, {
      method: "sessions.create",
      params: this.buildDraftSessionCreateParams({ visibility: "incognito" }),
    });
    return access.allowed ? undefined : access.reason;
  }

  canSubmit(): boolean {
    return this.submitBlock() === undefined;
  }

  /** Single owner for submit state, tooltips, and blocked-Enter notices. */
  submitBlock(): NewSessionSubmitBlock | undefined {
    if (
      !catalog.isTarget(this.read().data) &&
      this.attachmentDraft.pendingReads === 0 &&
      this.startedSession.isCurrent(this.read().context, this.place.agentId)
    ) {
      return this.activeSubmission ? { gate: "submitting" } : undefined;
    }
    return resolveNewSessionSubmitBlock({
      gatewayState: this.gateway,
      placeState: this.place,
      pendingPlacement: this.pendingPlacement,
      submitting: this.activeSubmission !== null,
      message: this.messageValue,
      submissionOutcomeUnknown: this.submissionOutcomeUnknown,
      pendingAttachmentReads: this.attachmentDraft.pendingReads,
      hasDraftAttachments: this.attachmentDraft.attachments.length > 0,
      hasCapabilityOverrides: this.capabilities.toolOverrides !== null,
      mentions: this.mentionsValue,
      visibility: this.visibilityValue,
      submissionSnapshot: () => this.read(),
      requiresModelSetup: () => this.requiresModelSetup(),
      submissionAccess: () => this.submissionAccess(),
      placementTargetForSubmission: () => this.placement().target,
      cloudDisabledReason: () => this.cloudDisabledReason(),
      cloudRuntimeUnsupportedReason: () =>
        this.place.modelControl.cloudRuntimeUnsupportedReason(
          this.gateway.cloudProfiles.find((profile) => profile.id === this.place.cloudProfileId),
        ),
    });
  }

  requiresModelSetup(): boolean {
    return requiresNewSessionModelSetup({
      snapshot: this.read(),
      gateway: this.gateway,
      place: this.place,
      pendingPlacement: this.pendingPlacement,
    });
  }

  cloudDisabledReason = () => resolveCloudPlacementDisabledReason(this.place);

  invalidate(outcomeUnknown: SubmissionOutcomeReason | null = null) {
    this.submitRequestToken += 1;
    this.startedSession.current = null;
    const interrupted =
      outcomeUnknown !== null && this.activeSubmission !== null && this.sessionStartup.interrupt();
    if (
      (outcomeUnknown && this.activeSubmission && !interrupted) ||
      this.sessionStartup.retireChangedOwner()
    ) {
      this.submissionOutcomeUnknown = outcomeUnknown;
    }
    // A recoverable reconnect still owns the submission; do not flash the draft
    // while the same frozen create request waits to resume.
    if (!interrupted) {
      this.activeSubmission = null;
    }
    this.callbacks.requestUpdate();
  }

  resetDraft() {
    this.sessionStartup.clear();
    const preservePendingPlacement = Boolean(this.pendingPlacement.sessionKey);
    this.blockedSubmitGate = null;
    this.invalidate();
    this.submissionOutcomeUnknown = preservePendingPlacement
      ? (this.submissionOutcomeUnknown ?? "placement-interrupted")
      : null;
    this.visibilityValue = "normal";
    this.capabilities.reset();
    this.permission.reset();
    this.attachmentDraft.reset({ release: true });
    if (preservePendingPlacement) {
      if (!this.pendingPlacement.restored) {
        this.pendingPlacement.retryAllowed = false;
      }
      this.applyRecoveryDraft(this.pendingPlacement.capture());
      this.pendingPlacement.restored = false;
    } else {
      this.clearPendingPlacementRecovery();
      this.draftPersistence.noteDraftReplaced();
      this.messageValue = "";
      this.mentionsValue = [];
    }
    this.error = null;
    this.callbacks.requestUpdate();
  }

  clearPendingPlacementRecovery() {
    this.pendingPlacement.clear();
    this.submissionOutcomeUnknown = null;
    this.callbacks.requestUpdate();
  }

  releasePendingPlacementOwner() {
    this.pendingPlacement.reset();
    this.submissionOutcomeUnknown = null;
    this.callbacks.requestUpdate();
  }

  restorePendingPlacementRecovery(gatewayUrl: string, recoveryScope: string) {
    this.applyRecoveryDraft(this.pendingPlacement.restore(gatewayUrl, recoveryScope));
  }

  async submit(startup?: DraftStartupResumption, backgroundRequested = false) {
    if (!startup && catalog.isTarget(this.read().data)) {
      return this.startInTerminal();
    }
    const background = backgroundRequested && !startup && this.visibilityValue !== "draft";
    const context = this.read().context;
    if (!context || (!startup && !this.canSubmit())) {
      this.noteBlockedSubmitAttempt();
      return;
    }
    const preparedTitle = this.callbacks.takePreparedTitle?.();
    this.blockedSubmitGate = null;
    const pendingPlacement = !startup && Boolean(this.pendingPlacement.sessionKey);
    const submitted = trimHumanMentions(this.messageValue, this.mentions);
    const message =
      startup?.params.message ??
      (pendingPlacement ? this.pendingPlacement.message : submitted.text);
    const mentions = (
      startup
        ? startup.params.mentions
        : pendingPlacement
          ? this.pendingPlacement.mentions
          : submitted.mentions
    )?.map(({ profileId, start, end }) => ({ profileId, start, end }));
    const attachments = this.attachmentDraft.attachments;
    const draftAttachments = startup
      ? startup.params.attachments
      : pendingPlacement
        ? undefined
        : buildChatApiAttachments(attachments);
    const apiAttachments = pendingPlacement ? this.pendingPlacement.attachments : draftAttachments;
    const submissionAgentId =
      startup?.params.agentId ??
      (pendingPlacement ? this.pendingPlacement.agentId : normalizeAgentId(this.place.agentId));
    const submissionGatewayUrl = pendingPlacement
      ? this.pendingPlacement.gatewayUrl
      : context.gateway.connection.gatewayUrl;
    const submissionClient = context.gateway.snapshot.client;
    if (!submissionClient || !context.gateway.snapshot.hello) {
      return;
    }
    const completeInBackground = prepareBackgroundSessionCompletion({
      enabled: background,
      agentId: submissionAgentId,
      client: submissionClient,
      context,
      clearDraft: () => {
        this.messageValue = "";
        this.mentionsValue = [];
        this.sessionStartup.clear();
      },
    });
    const submissionRecoveryScope = pendingPlacement
      ? this.pendingPlacement.recoveryScope
      : submissionClient.recoveryScope;
    const requestId = ++this.submitRequestToken;
    const submittedAt = startup?.startedAt ?? Date.now();
    const { hello, selfUser } = context.gateway.snapshot;
    const sender =
      resolveCurrentUserIdentity(hello, submissionClient.instanceId, selfUser) ?? undefined;
    const initialTurn = { text: message, mentions, attachments, createdAt: submittedAt, sender };
    // The draft keeps custody until creation succeeds; this snapshot only makes
    // foreground submission visible while the Gateway is still admitting it.
    this.activeSubmission = {
      message: background ? null : buildLocalUserMessage(initialTurn, "available"),
    };
    this.error = null;
    this.place.browser.close();
    this.callbacks.closeTransientUi();
    this.callbacks.requestUpdate();
    try {
      const started = this.startedSession.current;
      if (started && this.startedSession.isCurrent(context, this.place.agentId)) {
        await this.startedSession.navigate(context, started);
        return;
      }
      this.startedSession.current = null;
      const placementTarget = startup ? null : this.placement().target;
      // Creation and placement can await; permission must keep the original input event.
      if (
        shouldAutoPromptNotificationsOnSend({
          connected: context.gateway.snapshot.phase === "connected",
          directComposerSend: !startup && !pendingPlacement && hasActiveNotificationPromptGesture(),
          message,
          hasAttachments: Boolean(apiAttachments?.length),
          isCommand: parseSlashCommand(message) !== null,
        })
      ) {
        autoPromptNotificationsOnSend(context);
      }
      const remoteProject =
        !startup && !pendingPlacement && !placementTarget && !message && !apiAttachments?.length
          ? this.place.browser.remoteProject
          : null;
      if (remoteProject && !remoteProject.projectId && !this.place.browser.projectId) {
        const project = await submissionClient.request<ProjectsAddResult>(
          "projects.add",
          { gitUrl: remoteProject.cloneUrl },
          { timeoutMs: null },
        );
        if (requestId !== this.submitRequestToken || this.gateway.client !== submissionClient) {
          return;
        }
        this.place.browser.recordRemoteProjectId(remoteProject.cloneUrl, project.id);
      }
      const createParams =
        startup?.params ??
        this.buildDraftSessionCreateParams({
          message: placementTarget ? "" : message,
          mentions: placementTarget ? undefined : mentions,
          displayName: preparedTitle,
          visibility:
            this.visibilityValue === "draft" &&
            !this.capabilities.canStartAsDraft(this.read().context)
              ? "normal"
              : this.visibilityValue,
          attachments: placementTarget ? undefined : draftAttachments,
        });
      const placementCreateParams = placementTarget
        ? pendingPlacement
          ? this.pendingPlacement.createParams
          : this.pendingPlacement.stageCreate({
              agentId: submissionAgentId,
              target: placementTarget,
              message,
              mentions,
              attachments: apiAttachments,
              gatewayUrl: submissionGatewayUrl,
              recoveryScope: submissionRecoveryScope,
              createParams,
              persistent: this.visibilityValue !== "incognito",
            })
        : undefined;
      const requestAccess = startup
        ? readSessionMethodAccess(context.gateway.snapshot, {
            method: "sessions.create",
            params: createParams,
          })
        : this.submissionAccess(placementCreateParams ?? createParams);
      if (!requestAccess.allowed) {
        this.sessionStartup.clear();
        this.error = requestAccess.reason;
        return;
      }
      const submissionPlacementRecovery = placementTarget ? this.pendingPlacement.capture() : null;
      if (placementTarget && !submissionPlacementRecovery) {
        this.setPlacementRecoveryUnavailable();
        return;
      }
      const recoveryOwnerKey = submissionPlacementRecovery?.sessionKey ?? "";
      const ownsRecovery = (sessionKey: string) =>
        this.pendingPlacement.owns(submissionGatewayUrl, submissionRecoveryScope, sessionKey);
      const ownsSubmissionRecovery = () => ownsRecovery(recoveryOwnerKey);
      const isSubmissionLifecycleCurrent = () =>
        this.read().isConnected &&
        submissionClient.recoveryScopeReady &&
        requestId === this.submitRequestToken &&
        this.gateway.client === submissionClient &&
        this.gateway.gatewayUrl === submissionGatewayUrl &&
        this.gateway.recoveryScope === submissionRecoveryScope;
      const result =
        pendingPlacement && this.pendingPlacement.phase !== "creating"
          ? { key: this.pendingPlacement.sessionKey, initialRun: { status: "idle" as const } }
          : await context.sessions.createResult(
              placementCreateParams ?? startup?.params ?? this.sessionStartup.start(createParams),
              { reconciliation: "background" },
            );
      if (requestId !== this.submitRequestToken && !placementTarget) {
        return;
      }
      if (!result) {
        if (requestId !== this.submitRequestToken) {
          return;
        }
        this.sessionStartup.clear();
        this.error = context.sessions.state.error ?? t("newSession.createFailed");
        return;
      }
      if (placementTarget && submissionPlacementRecovery) {
        if (
          submissionPlacementRecovery.phase === "creating" &&
          (!isSubmissionLifecycleCurrent() || !ownsSubmissionRecovery())
        ) {
          const cleanupError = await deleteSessionPlacementDraft(
            submissionClient,
            result.key,
            submissionAgentId,
          );
          if (cleanupError) {
            if (ownsSubmissionRecovery()) {
              this.pendingPlacement.promoteToDispatching(result.key);
              this.pendingPlacement.retryAllowed = true;
            }
            this.error = t("newSession.placementStartFailed", { error: cleanupError });
            this.callbacks.requestUpdate();
          } else if (ownsSubmissionRecovery()) {
            this.clearPendingPlacementRecovery();
          }
          return;
        }
        if (
          submissionPlacementRecovery.phase === "creating" &&
          isSubmissionLifecycleCurrent() &&
          ownsSubmissionRecovery() &&
          !this.pendingPlacement.promoteToDispatching(result.key)
        ) {
          this.setPlacementRecoveryUnavailable();
          return;
        }
        const recovery = this.pendingPlacement.capture();
        if (!recovery || recovery.phase === "creating") {
          this.setPlacementRecoveryUnavailable();
          return;
        }
        if (requestId !== this.submitRequestToken) {
          return;
        }
        context.placementStartup.start({
          recovery,
          persistRecovery: this.pendingPlacement.persistent,
          recovering: submissionPlacementRecovery.phase !== "creating",
          createdAt: submittedAt,
        });
        const ownsStartedPlacement = () =>
          isSubmissionLifecycleCurrent() && ownsRecovery(recovery.sessionKey);
        if (!ownsStartedPlacement()) {
          return;
        }
        await this.draftPersistence.clearSubmittedDraft();
        if (!ownsStartedPlacement()) {
          return;
        }
        this.pendingPlacement.reset();
        this.attachmentDraft.clearAfterSubmit(true);
        if (completeInBackground(recovery.sessionKey, recovery.messageId)) {
          return;
        }
        await this.startedSession.navigate(context, {
          client: submissionClient,
          key: result.key,
          agentId: submissionAgentId,
        });
        return;
      }
      if (requestId !== this.submitRequestToken) {
        return;
      }
      const { key: sessionKey, initialRun } = result;
      const handedOffAttachments =
        initialRun.status === "rejected" &&
        retainRejectedInitialTurn({
          agentId: this.place.agentId,
          attachments,
          context,
          error: initialRun.error,
          message,
          mentions,
          sessionKey,
        });
      if (initialRun.status === "started") {
        context.chatSubmissions.retain(
          buildInitialChatSubmission(sessionKey, initialTurn, submissionClient, initialRun.runId),
        );
      }
      await this.draftPersistence.clearSubmittedDraft();
      if (requestId !== this.submitRequestToken) {
        return;
      }
      this.attachmentDraft.clearAfterSubmit(!handedOffAttachments);
      if (
        completeInBackground(
          sessionKey,
          initialRun.status === "started" ? initialRun.runId : undefined,
        )
      ) {
        return;
      }
      await this.startedSession.navigate(context, {
        client: submissionClient,
        key: sessionKey,
        agentId: submissionAgentId,
      });
      this.sessionStartup.clear();
    } catch (error) {
      if (requestId === this.submitRequestToken && this.gateway.client === submissionClient) {
        this.sessionStartup.clear();
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestId === this.submitRequestToken) {
        this.activeSubmission = null;
        this.callbacks.requestUpdate();
      }
    }
  }

  private async startInTerminal() {
    const { context, data } = this.read();
    const client = context?.gateway.snapshot.client;
    const catalogId = data?.catalogId.trim() ?? "";
    const agentId = normalizeAgentId(this.place.agentId);
    if (!context || !client || !catalogId || !agentId || !this.canSubmit()) {
      this.noteBlockedSubmitAttempt();
      return;
    }
    this.blockedSubmitGate = null;
    const requestId = ++this.submitRequestToken;
    const initialMessage = this.messageValue.trim();
    this.activeSubmission = { message: null };
    this.error = null;
    this.place.browser.close();
    this.callbacks.closeTransientUi();
    this.callbacks.requestUpdate();
    try {
      const result = await startNewSessionInTerminal(
        client,
        {
          catalogId,
          agentId,
          hostId: this.place.terminalHostId,
          cwd:
            this.place.folder.trim() ||
            (this.place.terminalOnNode ? "" : this.place.workspacePath()),
          initialMessage,
          worktree: this.place.worktree,
          worktreeName: this.place.worktreeName,
          baseRef: this.place.baseRef,
        },
        () => requestId === this.submitRequestToken && this.gateway.client === client,
      );
      if (!result || requestId !== this.submitRequestToken || this.gateway.client !== client) {
        return;
      }
      this.startedSession.current = null;
      await this.draftPersistence.clearSubmittedDraft();
      if (requestId !== this.submitRequestToken || this.gateway.client !== client) {
        return;
      }
      this.messageValue = "";
      this.mentionsValue = [];
      this.attachmentDraft.clearAfterSubmit(true);
    } catch (error) {
      if (requestId === this.submitRequestToken && this.gateway.client === client) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestId === this.submitRequestToken) {
        this.activeSubmission = null;
        this.callbacks.requestUpdate();
      }
    }
  }

  disconnect() {
    this.startedSession.current = null;
    this.draftPersistence.disconnect();
    this.attachmentDraft.reset({ release: true });
    this.composerTextarea.disconnect();
  }

  private placement = () => resolveDraftSessionPlacement(this.pendingPlacement, this.place);

  private setPlacementRecoveryUnavailable() {
    this.error = t("newSession.placementStartFailed", {
      error: "placement recovery storage is unavailable",
    });
  }

  private applyRecoveryDraft(recovery: SessionPlacementRecovery | null) {
    if (!recovery) {
      return;
    }
    const projection = projectDraftSessionPlacementRecovery(recovery);
    this.place.applyPendingPlacement(projection.placement);
    this.restoreDraftState(projection.draft);
  }
}
