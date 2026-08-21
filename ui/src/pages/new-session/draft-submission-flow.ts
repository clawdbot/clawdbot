import type { ProjectsAddResult } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { openTerminalSessionInTerminal } from "../../lib/sessions/catalog-terminal.ts";
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
import * as catalog from "./catalog-target.ts";
import { NewSessionComposerTextareaController } from "./composer.ts";
import {
  buildDraftSessionCreateParams as assembleDraftSessionCreateParams,
  canStartSessionAsDraft,
  type NewSessionVisibility,
} from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import {
  projectDraftSessionPlacementRecovery,
  resolveDraftSessionPlacement,
} from "./draft-session-placement.ts";
import type {
  DraftSubmissionCallbacks,
  DraftSubmissionSnapshot,
} from "./draft-submission-contract.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import {
  PendingSessionPlacementRecoveryState,
  type SubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";
import {
  PAGE_RENDERED_GATES,
  resolveNewSessionSubmitBlock,
  type NewSessionSubmitBlock,
} from "./submit-gates.ts";
import { readNewSessionTerminalStartAccess, startNewSessionInTerminal } from "./terminal-start.ts";

export class DraftSubmissionFlow {
  private visibilityValue: NewSessionVisibility = "normal";
  private messageValue = "";
  private submittingValue = false;
  private blockedSubmitGate: string | null = null;
  private submissionOutcomeUnknownValue: SubmissionOutcomeReason | null = null;
  private readonly startedSession = new StartedSessionNavigation();
  error: string | null = null;
  private submitRequestToken = 0;
  readonly pendingPlacement = new PendingSessionPlacementRecoveryState();
  readonly attachmentDraft: NewSessionAttachmentDraft;
  readonly composerTextarea = new NewSessionComposerTextareaController();
  readonly draftPersistence: NewSessionDraftPersistence;

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly place: DraftPlaceState,
    private readonly read: () => DraftSubmissionSnapshot,
    private readonly callbacks: DraftSubmissionCallbacks,
  ) {
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
    return this.submittingValue;
  }

  get submissionOutcomeUnknown(): SubmissionOutcomeReason | null {
    return this.submissionOutcomeUnknownValue;
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
  }) {
    this.draftPersistence.noteDraftReplaced();
    this.messageValue = state.message;
    this.visibilityValue = state.visibility;
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
    if (error === null && this.error === t("newSession.cloudRecoveryUnavailable")) {
      this.error = null;
    } else if (error !== null) {
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
    this.submissionOutcomeUnknownValue = outcome;
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
    if (!block?.reason || block.gate !== this.blockedSubmitGate) {
      return undefined;
    }
    return PAGE_RENDERED_GATES.has(block.gate) ? undefined : block.reason;
  }

  canStartAsDraft(): boolean {
    return canStartSessionAsDraft({
      allowedVisibilities:
        this.read().context?.gateway.snapshot.hello?.policy?.allowedSessionVisibilities,
      hasMultipleIdentities:
        this.read().context?.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities,
    });
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
    options: {
      message?: string;
      attachments?: unknown[];
      visibility?: NewSessionVisibility;
    } = {},
  ): Record<string, unknown> {
    const snapshot = this.read();
    return assembleDraftSessionCreateParams({
      agentId: this.place.agentId,
      message: options.message ?? "",
      model: this.place.modelControl.selected,
      thinkingLevel: this.place.modelControl.thinkingLevel,
      visibility: options.visibility ?? this.visibilityValue,
      attachments: options.attachments,
      projectId: this.place.browser.remoteProject?.projectId ?? this.place.browser.projectId,
      worktree: this.place.worktree,
      baseRef: this.place.baseRef,
      worktreeName: this.place.worktreeName,
      cwd: this.place.folder,
      workspace: this.place.workspacePath(),
      catalogId: snapshot.data?.catalogId,
      category: this.gateway.resolvedGroupCategory(),
    });
  }

  submissionAccess(
    createParams: Record<string, unknown> = this.pendingPlacement.createParams ??
      this.buildDraftSessionCreateParams(),
  ): SessionMethodAccess {
    const gateway = this.read().context?.gateway.snapshot;
    const pendingPlacement = Boolean(this.pendingPlacement.sessionKey);
    const remoteProject = this.place.browser.remoteProject;
    if (!pendingPlacement && remoteProject && !remoteProject.projectId) {
      return readSessionMethodAccess(gateway, {
        method: "projects.add",
        requiredScope: "operator.write",
      });
    }
    if (!pendingPlacement || this.pendingPlacement.phase === "creating") {
      const createAccess = readSessionMethodAccess(gateway, {
        method: "sessions.create",
        params: createParams,
      });
      if (!createAccess.allowed || !this.placement().target) {
        return createAccess;
      }
    }
    const target = this.placement().target;
    if (!target) {
      return readSessionMethodAccess(gateway, {
        method: "sessions.create",
        params: createParams,
      });
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

  terminalStartDisabledReason(): string | undefined {
    return this.submitBlock("terminal")?.reason;
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
        submissionOutcomeUnknown: this.submissionOutcomeUnknownValue,
        pendingAttachmentReads: this.attachmentDraft.pendingReads,
        hasDraftAttachments: this.attachmentDraft.attachments.length > 0,
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
        cloudRuntimeUnsupportedReason: () => this.cloudRuntimeUnsupportedReason(),
      },
      kind,
    );
  }

  requiresModelSetup(): boolean {
    const selectedAgent = this.place.selectedAgent();
    return requiresChatModelSetup({
      catalog:
        catalog.isTarget(this.read().data) ||
        Boolean(this.place.cloudProfileId || this.place.deviceId) ||
        Boolean(this.pendingPlacement.sessionKey),
      connected: this.gateway.connected,
      agentsLoaded: this.read().context?.agents.state.agentsList !== null,
      selectedAgentFound: selectedAgent !== undefined,
      agentModel: selectedAgent?.model?.primary,
    });
  }

  cloudDisabledReason(): string | undefined {
    const runtimeReason = this.place.modelControl.cloudRuntimeUnsupportedReason();
    if (runtimeReason) {
      return runtimeReason;
    }
    if (this.place.repository.kind === "checking") {
      return t("newSession.checkingGit");
    }
    if (this.place.repository.kind === "unavailable" && !this.place.worktreeAvailable()) {
      return t("newSession.gitCheckUnavailable");
    }
    return this.place.worktreeAvailable() ? undefined : t("newSession.cloudRequiresWorktree");
  }

  invalidate(outcomeUnknown: SubmissionOutcomeReason | null = null) {
    this.submitRequestToken += 1;
    this.startedSession.current = null;
    if (outcomeUnknown && this.submittingValue) {
      this.submissionOutcomeUnknownValue = outcomeUnknown;
    }
    this.submittingValue = false;
    this.callbacks.requestUpdate();
  }

  resetDraft() {
    const preservePendingPlacement = Boolean(this.pendingPlacement.sessionKey);
    this.blockedSubmitGate = null;
    this.invalidate();
    this.submissionOutcomeUnknownValue = preservePendingPlacement
      ? (this.submissionOutcomeUnknownValue ?? "placement-interrupted")
      : null;
    this.visibilityValue = "normal";
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
    this.submissionOutcomeUnknownValue = null;
    this.callbacks.requestUpdate();
  }

  releasePendingPlacementOwner() {
    this.pendingPlacement.reset();
    this.submissionOutcomeUnknownValue = null;
    this.callbacks.requestUpdate();
  }

  restorePendingPlacementRecovery(gatewayUrl: string, recoveryScope: string) {
    const recovery = this.pendingPlacement.restore(gatewayUrl, recoveryScope);
    if (!recovery) {
      return;
    }
    this.applyRecoveryDraft(recovery);
  }

  async submit() {
    const context = this.read().context;
    if (!context || !this.canSubmit()) {
      this.noteBlockedSubmitAttempt();
      return;
    }
    this.blockedSubmitGate = null;
    const pendingPlacement = Boolean(this.pendingPlacement.sessionKey);
    const message = pendingPlacement ? this.pendingPlacement.message : this.messageValue.trim();
    const attachments = this.attachmentDraft.attachments;
    const apiAttachments = pendingPlacement
      ? this.pendingPlacement.attachments
      : buildChatApiAttachments(attachments);
    const submissionAgentId = pendingPlacement
      ? this.pendingPlacement.agentId
      : normalizeAgentId(this.place.agentId);
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
    const submittedAt = Date.now();
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
      const remoteProject = pendingPlacement ? null : this.place.browser.remoteProject;
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
      const { target: placementTarget } = this.placement();
      const draftRetired = this.visibilityValue === "draft" && !this.canStartAsDraft();
      const createParams = this.buildDraftSessionCreateParams({
        message: placementTarget ? "" : message,
        visibility: draftRetired ? "normal" : this.visibilityValue,
        attachments: placementTarget ? undefined : apiAttachments,
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
      const requestAccess = this.submissionAccess(placementCreateParams ?? createParams);
      if (!requestAccess.allowed) {
        this.error = requestAccess.reason;
        return;
      }
      if (placementTarget && !pendingPlacement && !placementCreateParams) {
        this.error = t("newSession.placementStartFailed", {
          error: "placement recovery storage is unavailable",
        });
        return;
      }
      const submissionPlacementRecovery = placementTarget ? this.pendingPlacement.capture() : null;
      if (placementTarget && !submissionPlacementRecovery) {
        this.error = t("newSession.placementStartFailed", {
          error: "placement recovery storage is unavailable",
        });
        return;
      }
      const recoveryOwnerKey = submissionPlacementRecovery?.sessionKey ?? "";
      const ownsSubmissionRecovery = () =>
        this.pendingPlacement.owns(submissionGatewayUrl, submissionRecoveryScope, recoveryOwnerKey);
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
          : await context.sessions.createResult(placementCreateParams ?? createParams, {
              reconciliation: "background",
            });
      if (requestId !== this.submitRequestToken && !placementTarget) {
        return;
      }
      if (!result) {
        if (requestId !== this.submitRequestToken) {
          return;
        }
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
            this.pendingPlacement.promoteToDispatching(result.key);
            this.pendingPlacement.retryAllowed = true;
            this.error = t("newSession.placementStartFailed", { error: cleanupError });
            this.callbacks.requestUpdate();
          } else {
            this.clearPendingPlacementRecovery();
          }
          return;
        }
        if (
          submissionPlacementRecovery.phase === "creating" &&
          isSubmissionLifecycleCurrent() &&
          ownsSubmissionRecovery()
        ) {
          if (!this.pendingPlacement.promoteToDispatching(result.key)) {
            this.error = t("newSession.placementStartFailed", {
              error: "placement recovery storage is unavailable",
            });
            return;
          }
        }
        const recovery = this.pendingPlacement.capture();
        if (!recovery || recovery.phase === "creating") {
          this.error = t("newSession.placementStartFailed", {
            error: "placement recovery storage is unavailable",
          });
          return;
        }
        if (requestId !== this.submitRequestToken) {
          return;
        }
        context.placementStartup.start({
          recovery,
          persistRecovery: this.pendingPlacement.persistent,
          recovering: pendingPlacement,
          createdAt: submittedAt,
        });
        if (
          requestId !== this.submitRequestToken ||
          !isSubmissionLifecycleCurrent() ||
          !this.pendingPlacement.owns(
            submissionGatewayUrl,
            submissionRecoveryScope,
            recovery.sessionKey,
          )
        ) {
          return;
        }
        await this.draftPersistence.clearSubmittedDraft();
        if (
          requestId !== this.submitRequestToken ||
          !isSubmissionLifecycleCurrent() ||
          !this.pendingPlacement.owns(
            submissionGatewayUrl,
            submissionRecoveryScope,
            recovery.sessionKey,
          )
        ) {
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
        prepareInitialUserMessageHandoff(
          context.initialUserMessage,
          result.key,
          { text: message, attachments, createdAt: submittedAt },
          submissionClient,
          { runId: result.initialRun.runId, messageSeq: result.initialRun.messageSeq },
        );
      }
      await this.draftPersistence.clearSubmittedDraft();
      if (requestId !== this.submitRequestToken) {
        return;
      }
      this.attachmentDraft.clearAfterSubmit(!handedOffAttachments);
      if (requestId !== this.submitRequestToken) {
        return;
      }
      await this.startedSession.navigate(context, {
        client: submissionClient,
        key: result.key,
        agentId: submissionAgentId,
      });
    } catch (error) {
      if (requestId === this.submitRequestToken && this.gateway.client === submissionClient) {
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

  private cloudRuntimeUnsupportedReason(): string | undefined {
    const profile = this.gateway.cloudProfiles.find(
      (candidate) => candidate.id === this.place.cloudProfileId,
    );
    return this.place.modelControl.cloudRuntimeUnsupportedReason(profile);
  }

  private applyRecoveryDraft(recovery: SessionPlacementRecovery) {
    const projection = projectDraftSessionPlacementRecovery(recovery);
    this.place.applyPendingPlacement(projection.placement);
    this.restoreDraftState(projection.draft);
  }
}
