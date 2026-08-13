import type {
  ProjectsAddResult,
  SessionsCatalogStartTerminalResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context.ts";
import { navigateWithRouteTransition } from "../../app/route-transition.ts";
import { t } from "../../i18n/index.ts";
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
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";
import { buildChatApiAttachments, restoreChatApiAttachments } from "../chat/attachment-api.ts";
import { requiresChatModelSetup } from "../chat/chat-model-setup.ts";
import { prepareInitialUserMessageHandoff } from "../chat/initial-turn-handoff.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import * as catalog from "./catalog-target.ts";
import { PendingCloudRecoveryState, type SubmissionOutcomeReason } from "./cloud-recovery-state.ts";
import { NewSessionComposerTextareaController } from "./composer.ts";
import {
  buildDraftSessionCreateParams as assembleDraftSessionCreateParams,
  canStartSessionAsDraft,
  isWorktreeNameValid,
  type NewSessionVisibility,
} from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";

type DraftSubmissionSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  isConnected: boolean;
}>;

type DraftSubmissionCallbacks = {
  requestUpdate: () => void;
  closeTransientUi: () => void;
};

export class DraftSubmissionFlow {
  private visibilityValue: NewSessionVisibility = "normal";
  private messageValue = "";
  private submittingValue = false;
  private submissionOutcomeUnknownValue: SubmissionOutcomeReason | null = null;
  private errorValue: string | null = null;
  private submitRequestToken = 0;
  readonly pendingCloud = new PendingCloudRecoveryState();
  readonly attachmentDraft: NewSessionAttachmentDraft;
  readonly composerTextarea = new NewSessionComposerTextareaController();

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly place: DraftPlaceState,
    private readonly read: () => DraftSubmissionSnapshot,
    private readonly callbacks: DraftSubmissionCallbacks,
  ) {
    this.attachmentDraft = new NewSessionAttachmentDraft(callbacks.requestUpdate);
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

  get error(): string | null {
    return this.errorValue;
  }

  setMessage(message: string) {
    this.messageValue = message;
    this.callbacks.requestUpdate();
  }

  setVisibility(visibility: NewSessionVisibility) {
    this.visibilityValue = visibility;
    this.callbacks.requestUpdate();
  }

  setError(error: string | null) {
    if (error === null && this.errorValue === t("newSession.cloudRecoveryUnavailable")) {
      this.errorValue = null;
    } else if (error !== null) {
      this.errorValue = error;
    }
    this.callbacks.requestUpdate();
  }

  clearError() {
    this.errorValue = null;
    this.callbacks.requestUpdate();
  }

  clearErrorIf(error: string) {
    if (this.errorValue === error) {
      this.errorValue = null;
      this.callbacks.requestUpdate();
    }
  }

  markPendingCloudUnavailable(outcome: SubmissionOutcomeReason) {
    this.pendingCloud.retryAllowed = false;
    this.submissionOutcomeUnknownValue = outcome;
    this.callbacks.requestUpdate();
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
      catalogId: this.read().data?.catalogId,
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
      requiredScope: "operator.admin",
    });
  }

  submitDisabledReason(): string | undefined {
    const access = this.submissionAccess();
    return access.allowed ? undefined : access.reason;
  }

  terminalStartDisabledReason(): string | undefined {
    const access = this.terminalStartAccess();
    return access.allowed ? undefined : access.reason;
  }

  incognitoDisabledReason(): string | undefined {
    const access = readSessionMethodAccess(this.read().context?.gateway.snapshot, {
      method: "sessions.create",
      params: this.buildDraftSessionCreateParams({ visibility: "incognito" }),
    });
    return access.allowed ? undefined : access.reason;
  }

  canSubmit(kind: "session" | "terminal" = "session"): boolean {
    const pendingCloud = Boolean(this.pendingCloud.sessionKey);
    const cloudProfileId = this.cloudProfileForSubmission();
    const message = pendingCloud ? this.pendingCloud.message : this.messageValue.trim();
    const hasAttachments = pendingCloud
      ? Boolean(this.pendingCloud.attachments?.length)
      : this.attachmentDraft.attachments.length > 0;
    const gateway = this.read().context?.gateway;
    if (
      this.submittingValue ||
      this.gateway.preferenceLoading ||
      this.requiresModelSetup() ||
      this.attachmentDraft.pendingReads > 0 ||
      (!pendingCloud && this.submissionOutcomeUnknownValue) ||
      (kind === "session" && !message && !hasAttachments) ||
      gateway?.snapshot.phase !== "connected" ||
      !gateway.snapshot.client
    ) {
      return false;
    }
    const access = kind === "terminal" ? this.terminalStartAccess() : this.submissionAccess();
    if (!access.allowed || this.place.folderSubmissionBlocked()) {
      return false;
    }
    if (this.place.modelControl.isRestoringPreference() || !this.place.worktreePreferenceReady) {
      return false;
    }
    if (pendingCloud) {
      return Boolean(
        this.pendingCloud.retryAllowed &&
        gateway.snapshot.client.recoveryScopeReady &&
        cloudProfileId &&
        this.pendingCloud.agentId &&
        this.pendingCloud.gatewayUrl === gateway.connection.gatewayUrl &&
        this.pendingCloud.recoveryScope === gateway.snapshot.client?.recoveryScope &&
        this.place.isAdmin(),
      );
    }
    if (this.place.agents().length === 0) {
      return false;
    }
    if (!catalog.allowsSelectedAgent(this.read().data, this.place.selectedAgent())) {
      return false;
    }
    if (!this.place.execNodeReady()) {
      return false;
    }
    if (
      cloudProfileId &&
      (!this.place.isAdmin() ||
        !gateway.snapshot.client.recoveryScope ||
        !gateway.snapshot.client.recoveryScopeReady ||
        !this.gateway.cloudProfilesReady ||
        this.gateway.cloudProfilesPending ||
        !this.place.worktree ||
        !this.gateway.cloudProfiles.some((profile) => profile.id === cloudProfileId) ||
        Boolean(this.cloudRuntimeUnsupportedReason()))
    ) {
      return false;
    }
    if (this.place.execNode && this.place.worktree) {
      return false;
    }
    if (this.place.worktree && !this.place.worktreeAvailable()) {
      return false;
    }
    if (this.place.worktree && !isWorktreeNameValid(this.place.worktreeName)) {
      return false;
    }
    if (kind === "terminal" && !(this.place.folder.trim() || this.place.workspacePath())) {
      return false;
    }
    return true;
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
    this.errorValue = null;
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
    this.callbacks.requestUpdate();
  }

  private navigateToStartedSession(
    context: ApplicationContext,
    options: ApplicationNavigationOptions,
  ): Promise<void> {
    // Keep transition code on the lazy new-session path instead of the startup bundle.
    return navigateWithRouteTransition({
      document,
      from: "new-session",
      to: "chat",
      prefersReducedMotion:
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      prepare: () => context.preload("chat", options),
      navigate: () => context.navigateAndWait("chat", options),
    }).catch(() => undefined);
  }

  async submit() {
    const context = this.read().context;
    if (!context || !this.canSubmit()) {
      return;
    }
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
    this.errorValue = null;
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
        this.errorValue = requestAccess.reason;
        return;
      }
      if (cloudProfileId && !pendingCloud && !cloudCreateParams) {
        this.errorValue = t("newSession.cloudStartFailed", {
          error: "cloud recovery storage is unavailable",
        });
        return;
      }
      const submissionCloudRecovery = cloudProfileId ? this.pendingCloud.capture() : null;
      if (cloudProfileId && !submissionCloudRecovery) {
        this.errorValue = t("newSession.cloudStartFailed", {
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
        this.errorValue = context.sessions.state.error ?? t("newSession.createFailed");
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
            this.errorValue = t("newSession.cloudStartFailed", { error: cleanupError });
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
            this.errorValue = t("newSession.cloudStartFailed", {
              error: "cloud recovery storage is unavailable",
            });
            return;
          }
        }
        const recovery = this.pendingCloud.capture();
        if (!recovery || recovery.phase === "creating") {
          this.errorValue = t("newSession.cloudStartFailed", {
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
        this.pendingCloud.reset();
        this.attachmentDraft.clearAfterSubmit(true);
        selectApplicationSession({
          selection: context.agentSelection,
          gateway: context.gateway,
          sessionKey: result.key,
          agentId: submissionAgentId,
        });
        await this.navigateToStartedSession(
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
      await this.navigateToStartedSession(
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
        this.errorValue = error instanceof Error ? error.message : String(error);
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
      return;
    }
    const requestId = ++this.submitRequestToken;
    const initialMessage = this.messageValue.trim();
    this.submittingValue = true;
    this.errorValue = null;
    this.place.browser.close();
    this.callbacks.closeTransientUi();
    this.callbacks.requestUpdate();
    try {
      let cwd = this.place.folder.trim() || this.place.workspacePath();
      if (this.place.worktree) {
        const created = await createManagedWorktree(client, {
          repoRoot: cwd,
          name: this.place.worktreeName,
          baseRef: this.place.baseRef,
        });
        if (requestId !== this.submitRequestToken || this.gateway.client !== client) {
          return;
        }
        cwd = created.path;
      }
      const result = await client.request<SessionsCatalogStartTerminalResult>(
        "sessions.catalog.startTerminal",
        {
          catalogId,
          ...(this.place.execNode ? { hostId: `node:${this.place.execNode}` } : {}),
          agentId,
          cwd,
          ...(initialMessage ? { initialMessage } : {}),
        },
      );
      if (requestId !== this.submitRequestToken || this.gateway.client !== client) {
        return;
      }
      this.messageValue = "";
      openTerminalSessionInTerminal(result.sessionId);
    } catch (error) {
      if (requestId === this.submitRequestToken && this.gateway.client === client) {
        this.errorValue = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestId === this.submitRequestToken) {
        this.submittingValue = false;
        this.callbacks.requestUpdate();
      }
    }
  }

  disconnect() {
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
    const runtime = this.place.modelControl.resolveAgentRuntimeId({
      agent: this.place.selectedAgent(),
      context: this.read().context,
    });
    return runtime && runtime !== "openclaw"
      ? t("newSession.cloudRequiresOpenClawRuntime", { runtime })
      : undefined;
  }

  private applyRecoveryDraft(recovery: CloudSessionRecovery) {
    this.place.applyPendingCloud({
      agentId: recovery.agentId,
      profileId: recovery.profileId,
      cwd: recovery.createParams?.cwd,
    });
    this.visibilityValue = recovery.createParams?.incognito === true ? "incognito" : "normal";
    this.messageValue = recovery.message;
    this.attachmentDraft.replace(restoreChatApiAttachments(recovery.attachments));
  }
}
