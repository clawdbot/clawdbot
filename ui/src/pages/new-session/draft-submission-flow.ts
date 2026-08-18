import type { ProjectsAddResult } from "../../../../packages/gateway-protocol/src/index.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { openTerminalSessionInTerminal } from "../../lib/sessions/catalog-terminal.ts";
import type { CloudSessionRecovery } from "../../lib/sessions/cloud-recovery.ts";
import { deleteCloudDraftSession } from "../../lib/sessions/cloud-startup.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../../lib/terminal-availability.ts";
import { buildChatApiAttachments, restoreChatApiAttachments } from "../chat/attachment-api.ts";
import { requiresChatModelSetup } from "../chat/chat-model-setup.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "../chat/composer-persistence.ts";
import { prepareInitialUserMessageHandoff } from "../chat/initial-turn-handoff.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import * as catalog from "./catalog-target.ts";
import { PendingCloudRecoveryState, type SubmissionOutcomeReason } from "./cloud-recovery-state.ts";
import { NewSessionComposerTextareaController } from "./composer.ts";
import {
  buildDraftSessionCreateParams as assembleDraftSessionCreateParams,
  canStartSessionAsDraft,
  type NewSessionVisibility,
} from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type {
  DraftSubmissionCallbacks,
  DraftSubmissionSnapshot,
} from "./draft-submission-contract.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import { navigateToStartedSession } from "./started-session-navigation.ts";
import {
  PAGE_RENDERED_GATES,
  resolveNewSessionSubmitBlock,
  type NewSessionSubmitBlock,
} from "./submit-gates.ts";
import { startNewSessionInTerminal } from "./terminal-start.ts";

export class DraftSubmissionFlow {
  private visibilityValue: NewSessionVisibility = "normal";
  private messageValue = "";
  private submittingValue = false;
  private blockedSubmitGate: string | null = null;
  private submissionOutcomeUnknownValue: SubmissionOutcomeReason | null = null;
  error: string | null = null;
  private submitRequestToken = 0;
  readonly pendingCloud = new PendingCloudRecoveryState();
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
    this.attachmentDraft = new NewSessionAttachmentDraft(callbacks.requestUpdate, () =>
      this.draftPersistence.noteUserMutation(),
    );
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
    this.messageValue = message;
    this.draftPersistence.noteUserMutation();
    this.callbacks.requestUpdate();
  }

  restoreMessage(message: string) {
    this.messageValue = message;
    this.callbacks.requestUpdate();
  }

  restoreDraftState(state: {
    message: string;
    attachments: ChatAttachment[];
    visibility: NewSessionVisibility;
  }) {
    this.messageValue = state.message;
    this.visibilityValue = state.visibility;
    this.attachmentDraft.restore(state.attachments);
  }

  setVisibility(visibility: NewSessionVisibility) {
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
      this.error = null;
      this.callbacks.requestUpdate();
    }
  }

  markPendingCloudUnavailable(outcome: SubmissionOutcomeReason) {
    this.pendingCloud.retryAllowed = false;
    this.submissionOutcomeUnknownValue = outcome;
    this.callbacks.requestUpdate();
  }

  /** A submit was attempted (Enter or Start click) while a gate blocked it. */
  noteBlockedSubmitAttempt(kind: "session" | "terminal" = "session") {
    this.blockedSubmitGate = this.submitBlock(kind)?.gate ?? null;
    this.callbacks.requestUpdate();
  }

  /**
   * Reason to surface near the composer after a blocked submit attempt. Bound
   * to the gate captured at attempt time, so it disappears on its own once a
   * transient gate (preference restore, reconnect) lifts and never shows for
   * gates the user did not trip.
   */
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
      execNode: this.place.execNode,
      catalogId: snapshot.data?.catalogId,
      category: this.gateway.resolvedGroupCategory(),
    });
  }

  submissionAccess(
    createParams: Record<string, unknown> = this.pendingCloud.createParams ??
      this.buildDraftSessionCreateParams(),
  ): SessionMethodAccess {
    const gateway = this.read().context?.gateway.snapshot;
    const pendingCloud = Boolean(this.pendingCloud.sessionKey);
    const remoteProject = this.place.browser.remoteProject;
    if (!pendingCloud && remoteProject && !remoteProject.projectId) {
      return readSessionMethodAccess(gateway, {
        method: "projects.add",
        requiredScope: "operator.write",
      });
    }
    if (!pendingCloud || this.pendingCloud.phase === "creating") {
      const createAccess = readSessionMethodAccess(gateway, {
        method: "sessions.create",
        params: createParams,
      });
      if (!createAccess.allowed || !this.cloudProfileForSubmission()) {
        return createAccess;
      }
    }
    return readSessionMethodAccess(gateway, {
      method: "sessions.dispatch",
      requiredScope: "operator.write",
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

  /**
   * The single owner of every submit gate (`submit-gates.ts`). `canSubmit`,
   * the disabled-reason tooltips, and blocked Enter notices all derive from
   * that one walk, so a gate cannot block without a user-visible reason.
   */
  submitBlock(kind: "session" | "terminal" = "session"): NewSessionSubmitBlock | undefined {
    return resolveNewSessionSubmitBlock(
      {
        gatewayState: this.gateway,
        placeState: this.place,
        pendingCloud: this.pendingCloud,
        submitting: this.submittingValue,
        message: this.messageValue,
        submissionOutcomeUnknown: this.submissionOutcomeUnknownValue,
        pendingAttachmentReads: this.attachmentDraft.pendingReads,
        hasDraftAttachments: this.attachmentDraft.attachments.length > 0,
        submissionSnapshot: () => this.read(),
        requiresModelSetup: () => this.requiresModelSetup(),
        submissionAccess: () => this.submissionAccess(),
        terminalStartAccess: () => this.terminalStartAccess(),
        cloudProfileForSubmission: () => this.cloudProfileForSubmission(),
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
        Boolean(this.place.cloudProfileId) ||
        Boolean(this.pendingCloud.sessionKey),
      connected: this.gateway.connected,
      agentsLoaded: this.read().context?.agents.state.agentsList !== null,
      selectedAgentFound: selectedAgent !== undefined,
      agentModel: selectedAgent?.model?.primary,
    });
  }

  cloudDisabledReason(): string | undefined {
    const runtimeReason = this.cloudRuntimeUnsupportedReason();
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
    if (outcomeUnknown && this.submittingValue) {
      this.submissionOutcomeUnknownValue = outcomeUnknown;
    }
    this.submittingValue = false;
    this.callbacks.requestUpdate();
  }

  resetDraft() {
    const preservePendingCloud = Boolean(this.pendingCloud.sessionKey);
    this.blockedSubmitGate = null;
    this.invalidate();
    this.submissionOutcomeUnknownValue = preservePendingCloud
      ? (this.submissionOutcomeUnknownValue ?? "cloud-interrupted")
      : null;
    this.visibilityValue = "normal";
    this.attachmentDraft.reset({ release: true });
    if (preservePendingCloud) {
      if (!this.pendingCloud.restored) {
        this.pendingCloud.retryAllowed = false;
      }
      const recovery = this.pendingCloud.capture();
      if (recovery) {
        this.applyRecoveryDraft(recovery);
      }
      this.pendingCloud.restored = false;
    } else {
      this.clearPendingCloudRecovery();
      this.messageValue = "";
    }
    this.error = null;
    this.callbacks.requestUpdate();
  }

  clearPendingCloudRecovery() {
    this.pendingCloud.clear();
    this.submissionOutcomeUnknownValue = null;
    this.callbacks.requestUpdate();
  }

  resetPendingCloudWithoutClearingStorage() {
    this.pendingCloud.reset();
    this.submissionOutcomeUnknownValue = null;
    this.callbacks.requestUpdate();
  }

  restorePendingCloudRecovery(gatewayUrl: string, recoveryScope: string) {
    const recovery = this.pendingCloud.restore(gatewayUrl, recoveryScope);
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
    const pendingCloud = Boolean(this.pendingCloud.sessionKey);
    const message = pendingCloud ? this.pendingCloud.message : this.messageValue.trim();
    const attachments = this.attachmentDraft.attachments;
    const apiAttachments = pendingCloud
      ? this.pendingCloud.attachments
      : buildChatApiAttachments(attachments);
    const submissionAgentId = pendingCloud
      ? this.pendingCloud.agentId
      : normalizeAgentId(this.place.agentId);
    const submissionGatewayUrl = pendingCloud
      ? this.pendingCloud.gatewayUrl
      : context.gateway.connection.gatewayUrl;
    const submissionClient = context.gateway.snapshot.client;
    if (!submissionClient || !context.gateway.snapshot.hello) {
      return;
    }
    const submissionRecoveryScope = pendingCloud
      ? this.pendingCloud.recoveryScope
      : submissionClient.recoveryScope;
    const requestId = ++this.submitRequestToken;
    const submittedAt = Date.now();
    this.submittingValue = true;
    this.error = null;
    this.place.browser.close();
    this.callbacks.closeTransientUi();
    this.callbacks.requestUpdate();
    try {
      const remoteProject = pendingCloud ? null : this.place.browser.remoteProject;
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
      const cloudProfileId = this.cloudProfileForSubmission();
      const draftRetired = this.visibilityValue === "draft" && !this.canStartAsDraft();
      const createParams = this.buildDraftSessionCreateParams({
        message: cloudProfileId ? "" : message,
        visibility: draftRetired ? "normal" : this.visibilityValue,
        attachments: cloudProfileId ? undefined : apiAttachments,
      });
      const cloudCreateParams = cloudProfileId
        ? pendingCloud
          ? this.pendingCloud.createParams
          : this.pendingCloud.stageCreate({
              agentId: submissionAgentId,
              profileId: cloudProfileId,
              machineClass: this.place.machineClass,
              message,
              attachments: apiAttachments,
              gatewayUrl: submissionGatewayUrl,
              recoveryScope: submissionRecoveryScope,
              createParams,
              persistent: this.visibilityValue !== "incognito",
            })
        : undefined;
      const requestAccess = this.submissionAccess(cloudCreateParams ?? createParams);
      if (!requestAccess.allowed) {
        this.error = requestAccess.reason;
        return;
      }
      if (cloudProfileId && !pendingCloud && !cloudCreateParams) {
        this.error = t("newSession.cloudStartFailed", {
          error: "cloud recovery storage is unavailable",
        });
        return;
      }
      const submissionCloudRecovery = cloudProfileId ? this.pendingCloud.capture() : null;
      if (cloudProfileId && !submissionCloudRecovery) {
        this.error = t("newSession.cloudStartFailed", {
          error: "cloud recovery storage is unavailable",
        });
        return;
      }
      const recoveryOwnerKey = submissionCloudRecovery?.sessionKey ?? "";
      const ownsSubmissionRecovery = () =>
        this.pendingCloud.owns(submissionGatewayUrl, submissionRecoveryScope, recoveryOwnerKey);
      const isSubmissionLifecycleCurrent = () =>
        this.read().isConnected &&
        submissionClient.recoveryScopeReady &&
        requestId === this.submitRequestToken &&
        this.gateway.client === submissionClient &&
        this.gateway.gatewayUrl === submissionGatewayUrl &&
        this.gateway.recoveryScope === submissionRecoveryScope;
      const result =
        pendingCloud && this.pendingCloud.phase !== "creating"
          ? { key: this.pendingCloud.sessionKey, initialRun: { status: "idle" as const } }
          : await context.sessions.createResult(cloudCreateParams ?? createParams, {
              reconciliation: "background",
            });
      if (requestId !== this.submitRequestToken && !cloudProfileId) {
        return;
      }
      if (!result) {
        if (requestId !== this.submitRequestToken) {
          return;
        }
        this.error = context.sessions.state.error ?? t("newSession.createFailed");
        return;
      }
      if (cloudProfileId && submissionCloudRecovery) {
        if (
          submissionCloudRecovery.phase === "creating" &&
          (!isSubmissionLifecycleCurrent() || !ownsSubmissionRecovery())
        ) {
          const cleanupError = await deleteCloudDraftSession(
            submissionClient,
            result.key,
            submissionAgentId,
          );
          if (cleanupError) {
            this.pendingCloud.promoteToDispatching(result.key);
            this.pendingCloud.retryAllowed = true;
            this.error = t("newSession.cloudStartFailed", { error: cleanupError });
            this.callbacks.requestUpdate();
          } else {
            this.clearPendingCloudRecovery();
          }
          return;
        }
        if (
          submissionCloudRecovery.phase === "creating" &&
          isSubmissionLifecycleCurrent() &&
          ownsSubmissionRecovery()
        ) {
          if (!this.pendingCloud.promoteToDispatching(result.key)) {
            this.error = t("newSession.cloudStartFailed", {
              error: "cloud recovery storage is unavailable",
            });
            return;
          }
        }
        const recovery = this.pendingCloud.capture();
        if (!recovery || recovery.phase === "creating") {
          this.error = t("newSession.cloudStartFailed", {
            error: "cloud recovery storage is unavailable",
          });
          return;
        }
        if (requestId !== this.submitRequestToken) {
          return;
        }
        context.cloudStartup.start({
          recovery,
          persistRecovery: this.pendingCloud.persistent,
          recovering: pendingCloud,
          createdAt: submittedAt,
        });
        if (
          requestId !== this.submitRequestToken ||
          !isSubmissionLifecycleCurrent() ||
          !this.pendingCloud.owns(
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
          !this.pendingCloud.owns(
            submissionGatewayUrl,
            submissionRecoveryScope,
            recovery.sessionKey,
          )
        ) {
          return;
        }
        this.pendingCloud.reset();
        this.attachmentDraft.clearAfterSubmit(true);
        selectApplicationSession({
          selection: context.agentSelection,
          gateway: context.gateway,
          sessionKey: result.key,
          agentId: submissionAgentId,
        });
        await navigateToStartedSession(
          context,
          sessionNavigationTarget({
            context,
            face: "chat",
            sessionKey: result.key,
            agentId: this.place.agentId,
            focusComposer: true,
          }).options,
        );
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
      selectApplicationSession({
        selection: context.agentSelection,
        gateway: context.gateway,
        sessionKey: result.key,
        agentId: submissionAgentId,
      });
      await navigateToStartedSession(
        context,
        sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: result.key,
          agentId: this.place.agentId,
          focusComposer: true,
        }).options,
      );
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
          execNode: this.place.execNode,
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
    this.draftPersistence.disconnect();
    this.attachmentDraft.reset({ release: true });
    this.composerTextarea.disconnect();
  }

  private terminalStartAccess(): SessionMethodAccess {
    const gateway = this.read().context?.gateway.snapshot;
    const terminalAccess = readSessionMethodAccess(gateway, {
      method: "sessions.catalog.startTerminal",
      requiredScope: "operator.admin",
    });
    if (!terminalAccess.allowed || !this.place.worktree) {
      return terminalAccess;
    }
    return readSessionMethodAccess(gateway, {
      method: "worktrees.create",
      requiredScope: "operator.admin",
    });
  }

  private cloudProfileForSubmission(): string {
    return this.pendingCloud.sessionKey ? this.pendingCloud.profileId : this.place.cloudProfileId;
  }

  private cloudRuntimeUnsupportedReason(): string | undefined {
    const runtime = this.place.modelControl.resolveAgentRuntime({
      agent: this.place.selectedAgent(),
      context: this.read().context,
    });
    return runtime?.cloudPlacementSupported === false
      ? t("newSession.cloudRuntimeUnsupported", { runtime: runtime.id })
      : undefined;
  }

  private applyRecoveryDraft(recovery: CloudSessionRecovery) {
    this.place.applyPendingCloud({
      agentId: recovery.agentId,
      profileId: recovery.profileId,
      machineClass: recovery.machineClass,
      cwd: recovery.createParams?.cwd,
    });
    this.restoreDraftState({
      message: recovery.message,
      attachments: restoreChatApiAttachments(recovery.attachments),
      visibility: recovery.createParams?.incognito === true ? "incognito" : "normal",
    });
  }
}
