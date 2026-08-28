import type { ProjectsAddResult } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { openTerminalSessionInTerminal } from "../../lib/sessions/catalog-terminal.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { SessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import {
  deleteSessionPlacementDraft,
  sessionPlacementDispatchParams,
} from "../../lib/sessions/session-placement-startup.ts";
import { isTerminalAvailable } from "../../lib/terminal-availability.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import { requiresChatModelSetup } from "../chat/chat-model-setup.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "../chat/composer-persistence.ts";
import { prepareInitialUserMessageHandoff } from "../chat/initial-turn-handoff.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionCapabilityController } from "./capability-controller.ts";
import * as catalog from "./catalog-target.ts";
import { NewSessionComposerTextareaController } from "./composer.ts";
import {
  buildDraftSessionCreateParams as assembleDraftSessionCreateParams,
  type NewSessionVisibility,
} from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import {
  projectDraftSessionPlacementRecovery,
  resolveDraftSessionPlacement,
} from "./draft-session-placement.ts";
import { DraftSessionStartup } from "./draft-session-startup.ts";
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
  resolveCloudPlacementDisabledReason,
  resolveNewSessionSubmitBlock,
  type NewSessionSubmitBlock,
} from "./submit-gates.ts";
import { readNewSessionTerminalStartAccess, startNewSessionInTerminal } from "./terminal-start.ts";

export class DraftSubmissionFlow {
  private visibilityValue: NewSessionVisibility = "normal";
  private messageValue = "";
  private submittingValue = false;
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
        attachments: this.attachmentDraft.attachments,
        incognito: this.visibilityValue === "incognito",
      }),
      (message, attachments, resetVisibility) => {
        this.restoreDraftState({
          message,
          attachments,
          visibility: resetVisibility ? "normal" : this.visibilityValue,
        });
      },
      () => {
        this.error = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
        this.callbacks.requestUpdate();
      },
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

  get submitting(): boolean {
    return this.submittingValue || this.sessionStartup.active;
  }

  resumeInterruptedSubmission() {
    const startup = this.sessionStartup.resume();
    if (startup.kind === "resume") {
      void this.submit(startup);
    } else if (startup.kind !== "wait") {
      this.submissionOutcomeUnknown = "gateway-changed";
      this.callbacks.requestUpdate();
    }
  }

  setMessage(message: string) {
    this.startedSession.current = null;
    this.messageValue = message;
    this.draftPersistence.noteUserMutation();
    this.callbacks.requestUpdate();
  }

  restoreMessage(message: string) {
    this.draftPersistence.noteDraftReplaced();
    this.messageValue = message;
    this.callbacks.requestUpdate();
  }

  restoreDraftState(state: {
    message: string;
    attachments: ChatAttachment[];
    visibility: NewSessionVisibility;
    toolOverrides?: NewSessionCapabilityController["toolOverrides"];
    permissionMode?: SessionCreateParams["permissionMode"];
  }) {
    this.draftPersistence.noteDraftReplaced();
    this.messageValue = state.message;
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
  noteBlockedSubmitAttempt(kind: "session" | "terminal" = "session") {
    this.blockedSubmitGate = this.submitBlock(kind)?.gate ?? null;
    this.callbacks.requestUpdate();
  }

  /** Attempt-bound reason that retires when its transient gate lifts. */
  blockedSubmitNotice(): string | undefined {
    const block = this.blockedSubmitGate ? this.submitBlock() : undefined;
    return block?.gate === this.blockedSubmitGate && !PAGE_RENDERED_GATES.has(block.gate)
      ? block.reason
      : undefined;
  }

  showStartInTerminal(): boolean {
    const { context, data } = this.read();
    return Boolean(
      context &&
      catalog.isTarget(data) &&
      !this.placement().target &&
      data?.startTerminal &&
      context.config.current.cliAgentsEnabled === true &&
      isTerminalAvailable(
        context.gateway.snapshot,
        context.config.current.terminalEnabled ?? false,
      ),
    );
  }

  private buildDraftSessionCreateParams(
    options: Partial<Pick<SessionCreateParams, "message" | "attachments">> & {
      visibility?: NewSessionVisibility;
    } = {},
  ): SessionCreateParams {
    return assembleDraftSessionCreateParams({
      agentId: this.place.agentId,
      message: options.message ?? "",
      model: this.place.modelControl.selected,
      contextWindow: this.place.modelControl.contextWindow,
      thinkingLevel: this.place.modelControl.thinkingLevel,
      toolOverrides: this.capabilities.toolOverrides,
      permissionMode: this.permission.value,
      visibility: options.visibility ?? this.visibilityValue,
      attachments: options.attachments,
      projectId: this.place.browser.remoteProject?.projectId ?? this.place.browser.projectId,
      projectGitUrl: this.place.browser.remoteProject?.cloneUrl,
      worktree: this.place.worktree,
      baseRef: this.place.baseRef,
      worktreeName: this.place.worktreeName,
      cwd: this.place.folder,
      workspace: this.place.workspacePath(),
      catalogId: this.read().data?.catalogId,
      category: this.gateway.resolvedGroupCategory(),
    });
  }

  submissionAccess(
    createParams: Record<string, unknown> = this.pendingPlacement.createParams ??
      this.buildDraftSessionCreateParams(),
  ): SessionMethodAccess {
    const gateway = this.read().context?.gateway.snapshot;
    const pendingPlacement = Boolean(this.pendingPlacement.sessionKey);
    const target = this.placement().target;
    const hasInitialTurn = this.messageValue.trim() || this.attachmentDraft.attachments.length;
    const remoteProject = target || !hasInitialTurn ? this.place.browser.remoteProject : null;
    if (!pendingPlacement && remoteProject && !remoteProject.projectId) {
      const projectAccess = readSessionMethodAccess(gateway, {
        method: "projects.add",
        requiredScope: "operator.write",
      });
      if (!projectAccess.allowed) {
        return projectAccess;
      }
    }
    if (!target || !pendingPlacement || this.pendingPlacement.phase === "creating") {
      const createAccess = readSessionMethodAccess(gateway, {
        method: "sessions.create",
        params: createParams,
      });
      if (!createAccess.allowed || !target) {
        return createAccess;
      }
    }
    return readSessionMethodAccess(gateway, {
      method: "sessions.dispatch",
      requiredScope: target.kind === "profile" ? "operator.admin" : "operator.write",
      params: sessionPlacementDispatchParams({
        key: this.pendingPlacement.sessionKey,
        agentId: this.pendingPlacement.agentId || this.place.agentId,
        target,
      }),
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

  canSubmit(kind: "session" | "terminal" = "session"): boolean {
    return this.submitBlock(kind) === undefined;
  }

  /** Single owner for submit state, tooltips, and blocked-Enter notices. */
  submitBlock(kind: "session" | "terminal" = "session"): NewSessionSubmitBlock | undefined {
    if (
      kind === "session" &&
      this.attachmentDraft.pendingReads === 0 &&
      this.startedSession.isCurrent(this.read().context, this.place.agentId)
    ) {
      return this.submittingValue ? { gate: "submitting" } : undefined;
    }
    return resolveNewSessionSubmitBlock(
      {
        gatewayState: this.gateway,
        placeState: this.place,
        pendingPlacement: this.pendingPlacement,
        submitting: this.submittingValue,
        message: this.messageValue,
        submissionOutcomeUnknown: this.submissionOutcomeUnknown,
        pendingAttachmentReads: this.attachmentDraft.pendingReads,
        hasDraftAttachments: this.attachmentDraft.attachments.length > 0,
        hasCapabilityOverrides: this.capabilities.toolOverrides !== null,
        submissionSnapshot: () => this.read(),
        requiresModelSetup: () => this.requiresModelSetup(),
        submissionAccess: () => this.submissionAccess(),
        terminalStartAccess: () =>
          readNewSessionTerminalStartAccess(
            this.read().context?.gateway.snapshot,
            this.place.worktree,
          ),
        placementTargetForSubmission: () => this.placement().target,
        cloudDisabledReason: () => this.cloudDisabledReason(),
        cloudRuntimeUnsupportedReason: () =>
          this.place.modelControl.cloudRuntimeUnsupportedReason(
            this.gateway.cloudProfiles.find((profile) => profile.id === this.place.cloudProfileId),
          ),
      },
      kind,
    );
  }

  requiresModelSetup(): boolean {
    const selectedAgent = this.place.selectedAgent();
    return requiresChatModelSetup({
      catalog:
        catalog.isTarget(this.read().data) ||
        this.place.remotePlacement ||
        Boolean(this.pendingPlacement.sessionKey),
      connected: this.gateway.connected,
      agentsLoaded: this.read().context?.agents.state.agentsList !== null,
      selectedAgentFound: selectedAgent !== undefined,
      agentModel: selectedAgent?.model?.primary,
    });
  }

  cloudDisabledReason = () => resolveCloudPlacementDisabledReason(this.place);

  invalidate(outcomeUnknown: SubmissionOutcomeReason | null = null) {
    this.submitRequestToken += 1;
    this.startedSession.current = null;
    if (
      (outcomeUnknown && this.submittingValue && !this.sessionStartup.interrupt()) ||
      this.sessionStartup.retireChangedOwner()
    ) {
      this.submissionOutcomeUnknown = outcomeUnknown;
    }
    this.submittingValue = false;
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
      const recovery = this.pendingPlacement.capture();
      if (recovery) {
        this.applyRecoveryDraft(recovery);
      }
      this.pendingPlacement.restored = false;
    } else {
      this.clearPendingPlacementRecovery();
      this.draftPersistence.noteDraftReplaced();
      this.messageValue = "";
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
    const recovery = this.pendingPlacement.restore(gatewayUrl, recoveryScope);
    if (recovery) {
      this.applyRecoveryDraft(recovery);
    }
  }

  async submit(startup?: { params: SessionCreateParams; startedAt: number }) {
    const context = this.read().context;
    if (!context || (!startup && !this.canSubmit())) {
      this.noteBlockedSubmitAttempt();
      return;
    }
    this.blockedSubmitGate = null;
    const pendingPlacement = !startup && Boolean(this.pendingPlacement.sessionKey);
    const message =
      startup?.params.message ??
      (pendingPlacement ? this.pendingPlacement.message : this.messageValue.trim());
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
    const submissionRecoveryScope = pendingPlacement
      ? this.pendingPlacement.recoveryScope
      : submissionClient.recoveryScope;
    const requestId = ++this.submitRequestToken;
    const submittedAt = startup?.startedAt ?? Date.now();
    this.submittingValue = true;
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
      const hasInitialTurn = message || apiAttachments?.length;
      const remoteProject =
        !startup && !pendingPlacement && (placementTarget || !hasInitialTurn)
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
      const handedOffAttachments =
        result.initialRun.status === "rejected" &&
        retainRejectedInitialTurn({
          agentId: this.place.agentId,
          attachments,
          context,
          error: result.initialRun.error,
          message,
          sessionKey: result.key,
        });
      if (result.initialRun.status === "started") {
        const { hello, selfUser } = context.gateway.snapshot;
        const sender = resolveCurrentUserIdentity(hello, submissionClient.instanceId, selfUser);
        prepareInitialUserMessageHandoff(
          context.initialUserMessage,
          result.key,
          { text: message, attachments, createdAt: submittedAt, ...(sender ? { sender } : {}) },
          submissionClient,
          { runId: result.initialRun.runId, messageSeq: result.initialRun.messageSeq },
        );
      }
      await this.draftPersistence.clearSubmittedDraft();
      if (requestId !== this.submitRequestToken) {
        return;
      }
      this.attachmentDraft.clearAfterSubmit(!handedOffAttachments);
      await this.startedSession.navigate(context, {
        client: submissionClient,
        key: result.key,
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
        this.submittingValue = false;
        this.callbacks.requestUpdate();
      }
    }
  }

  async startInTerminal() {
    const { context, data } = this.read();
    const client = context?.gateway.snapshot.client;
    const catalogId = data?.catalogId.trim() ?? "";
    const agentId = normalizeAgentId(this.place.agentId);
    if (!context || !client || !catalogId || !agentId || !this.canSubmit("terminal")) {
      this.noteBlockedSubmitAttempt("terminal");
      return;
    }
    this.blockedSubmitGate = null;
    const requestId = ++this.submitRequestToken;
    const initialMessage = this.messageValue.trim();
    this.submittingValue = true;
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
          cwd: this.place.folder.trim() || this.place.workspacePath(),
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
      this.attachmentDraft.clearAfterSubmit(true);
      openTerminalSessionInTerminal(result.sessionId);
    } catch (error) {
      if (requestId === this.submitRequestToken && this.gateway.client === client) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestId === this.submitRequestToken) {
        this.submittingValue = false;
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

  private applyRecoveryDraft(recovery: SessionPlacementRecovery) {
    const projection = projectDraftSessionPlacementRecovery(recovery);
    this.place.applyPendingPlacement(projection.placement);
    this.restoreDraftState(projection.draft);
  }
}
