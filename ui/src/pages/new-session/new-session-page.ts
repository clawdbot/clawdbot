import { consume } from "@lit/context";
import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { property } from "lit/decorators.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { loadSettings } from "../../app/settings.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat.css";
import "../../styles/new-session.css";
import { clearChatModelSearchOnEscape } from "../chat/components/chat-model-picker.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import * as catalog from "./catalog-target.ts";
import type { SubmissionOutcomeReason } from "./cloud-recovery-state.ts";
import { renderDraftError, renderNewSessionDraftComposer } from "./composer.ts";
import { isWorktreeNameValid } from "./create-params.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionRouteData } from "./location.ts";
import { renderPlaceSelect } from "./place-picker.ts";
import { renderAgentSelect } from "./target-controls.ts";

function controllerHost(element: OpenClawLightDomElement): ReactiveControllerHost {
  return {
    addController: (controller: ReactiveController) => element.addController(controller),
    removeController: (controller: ReactiveController) => element.removeController(controller),
    requestUpdate: () => element.requestUpdate(),
    get updateComplete() {
      return element.updateComplete;
    },
  };
}

class NewSessionPage extends OpenClawLightDomElement {
  @property({ attribute: false }) data: NewSessionRouteData | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  private openedFor: string | null = null;
  private openedAgentId = "";
  private messageOwnerKey = "";
  private readonly gateway: DraftGatewayState;
  private readonly browser: DraftPlaceBrowser;
  private readonly place: DraftPlaceState;
  private readonly submission: DraftSubmissionFlow;
  private readonly subscriptions: SubscriptionsController;

  constructor() {
    super();
    const host = controllerHost(this);
    this.gateway = new DraftGatewayState(
      host,
      () => ({
        context: this.context,
        data: this.data,
        isConnected: this.isConnected,
        isAdmin: this.place?.isAdmin() ?? false,
        canStartAsDraft: this.submission?.canStartAsDraft() ?? false,
        visibility: this.submission?.visibility ?? "normal",
        cloudProfileId: this.place?.cloudProfileId ?? "",
        pendingCloud: this.submission?.pendingCloud ?? {
          sessionKey: "",
          gatewayUrl: "",
          recoveryScope: "",
        },
        agentsHydrated: this.place?.agentsHydrated ?? false,
      }),
      {
        requestUpdate: () => this.requestUpdate(),
        updateComplete: () => this.updateComplete,
        onInvalidate: (resetHostSelection, outcome) =>
          this.invalidateGatewayDiscovery(resetHostSelection, outcome),
        onVisibilityRetired: () => this.submission.setVisibility("normal"),
        onCloudProfileCleared: () => this.place.clearCloudProfile(),
        onCloudState: (error) => this.submission.setError(error),
        onPendingCloudReset: () => this.submission.resetPendingCloudWithoutClearingStorage(),
        onRecoveryReady: (gatewayUrl, recoveryScope) =>
          this.submission.restorePendingCloudRecovery(gatewayUrl, recoveryScope),
        onAdoptAgentDefaults: () =>
          this.place.adoptAgentDefaults({
            preserveSelectedAgent: true,
            preserveSelectedFolder: true,
          }),
      },
    );
    this.browser = new DraftPlaceBrowser(
      host,
      this.gateway,
      () => ({
        context: this.context,
        projectId: this.place?.projectId ?? "",
        nodes: this.place?.nodes ?? [],
        folder: this.place?.folder ?? "",
        execNode: this.place?.execNode ?? "",
        isAdmin: this.place?.isAdmin() ?? false,
      }),
      {
        requestUpdate: () => this.requestUpdate(),
        onProjectMissing: () => this.place.clearProjectSelection(),
        onSelectProject: (projectId) => this.place.selectProjectId(projectId),
        onApplyFolder: (folder, execNode, gatewayApproved) =>
          this.place.applyFolder(folder, execNode, gatewayApproved),
        onApprovedListing: (listing) => this.place.recordGatewayApprovedListing(listing),
        querySelector: (selector) => this.querySelector(selector),
        activeElement: () => this.ownerDocument.activeElement,
        body: () => this.ownerDocument.body,
      },
    );
    this.place = new DraftPlaceState(
      this.gateway,
      this.browser,
      () => ({
        context: this.context,
        data: this.data,
        submitting: this.submission?.submitting ?? false,
        pendingCloudSessionKey: this.submission?.pendingCloud.sessionKey ?? "",
      }),
      {
        requestUpdate: () => this.requestUpdate(),
        onError: (error) =>
          error === null ? this.submission.clearError() : this.submission.setError(error),
        onClearError: (error) => this.submission.clearErrorIf(error),
      },
    );
    this.submission = new DraftSubmissionFlow(
      this.gateway,
      this.place,
      () => ({ context: this.context, data: this.data, isConnected: this.isConnected }),
      {
        requestUpdate: () => this.requestUpdate(),
        closeTransientUi: () => this.closeOpenDropdowns(),
      },
    );
    this.subscriptions = new SubscriptionsController(this)
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.gateway.synchronize(gateway),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
      )
      .watch(
        () => this.context?.config,
        (config, notify) => config.subscribe(() => notify()),
      );
  }

  handleEvent(event: Event) {
    const pickers = this.querySelectorAll<HTMLDetailsElement>(
      ".chat-controls__inline-select[open]",
    );
    if (pickers.length === 0) {
      return;
    }
    if (event.type === "keydown") {
      const keyEvent = event as KeyboardEvent;
      clearChatModelSearchOnEscape(keyEvent);
      if (keyEvent.defaultPrevented || keyEvent.key !== "Escape") {
        return;
      }
      const picker =
        [...pickers].find((candidate) => event.composedPath().includes(candidate)) ?? pickers[0];
      if (!picker) {
        return;
      }
      const restoreFocus = event.composedPath().includes(picker);
      keyEvent.preventDefault();
      picker.open = false;
      if (restoreFocus) {
        picker.querySelector<HTMLElement>("summary")?.focus();
      }
      return;
    }
    pickers.forEach((picker) => {
      if (!event.composedPath().includes(picker)) {
        picker.open = false;
      }
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this, true);
    document.addEventListener("pointerdown", this, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this, true);
    document.removeEventListener("pointerdown", this, true);
    this.subscriptions.clear();
    this.gateway.invalidateDiscovery(
      true,
      this.submission.pendingCloud.sessionKey ? "cloud-interrupted" : "gateway-changed",
    );
    this.gateway.disconnect();
    this.browser.disconnect();
    this.submission.disconnect();
    super.disconnectedCallback();
  }

  override updated() {
    this.gateway.retryPendingCatalogTarget();
    this.place.modelControl.loadCatalogTargets(
      this.context,
      this.place.agentId,
      this.context?.config.current.cliAgentsEnabled === true && !catalog.isTarget(this.data),
    );
    const agentState = this.context?.agents.state;
    const agentsReady = Boolean(
      this.gateway.connected &&
      this.gateway.client &&
      agentState?.connected &&
      agentState.client === this.gateway.client &&
      this.place.agents().length > 0,
    );
    const openKey = this.data
      ? catalog.routeKey(this.data)
      : catalog.routeKeyFromSearch(window.location.search);
    const resolvedAgentId = this.data?.agentId ?? "";
    if (this.openedFor !== openKey) {
      const ownedMessage = this.messageOwnerKey === openKey ? this.submission.message : "";
      this.openedFor = openKey;
      this.openedAgentId = resolvedAgentId;
      this.place.setAgentsHydrated(agentsReady);
      this.resetDraft();
      if (ownedMessage) {
        this.setMessage(ownedMessage, openKey);
      }
      return;
    }
    if (this.openedAgentId !== resolvedAgentId) {
      this.openedAgentId = resolvedAgentId;
      this.place.setAgentsHydrated(false);
    }
    if (!this.place.agentsHydrated && agentsReady) {
      this.place.setAgentsHydrated(true);
      this.place.adoptAgentDefaults({
        preserveSelectedAgent: true,
        preserveSelectedFolder: true,
      });
    }
  }

  private invalidateGatewayDiscovery(
    resetHostSelection: boolean,
    submissionOutcome: SubmissionOutcomeReason,
  ) {
    this.place.invalidateGatewayDiscovery(resetHostSelection);
    this.submission.attachmentDraft.abortReads();
    this.submission.invalidate(submissionOutcome);
    if (resetHostSelection && this.submission.pendingCloud.sessionKey) {
      this.submission.markPendingCloudUnavailable(submissionOutcome);
    }
    if (resetHostSelection) {
      this.submission.clearError();
    }
  }

  private resetDraft() {
    this.place.resetDraft();
    this.submission.resetDraft();
    this.messageOwnerKey = catalog.routeKey(this.data);
    this.browser.clearPopoverHiding();
    this.closeAgentDropdown();
    this.browser.close();
    this.place.adoptAgentDefaults();
    void this.updateComplete.then(() => {
      this.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.focus();
    });
  }

  private setMessage(message: string, ownerKey = catalog.routeKey(this.data)) {
    this.submission.setMessage(message);
    this.messageOwnerKey = ownerKey;
  }

  private setMessageFromUser(message: string) {
    this.setMessage(message, catalog.routeKeyFromSearch(window.location.search));
  }

  private closeAgentDropdown() {
    const dropdown = this.querySelector<HTMLElement & { open: boolean }>(
      ".new-session-page__select--agent wa-dropdown",
    );
    if (dropdown) {
      dropdown.open = false;
    }
  }

  private closeOpenDropdowns() {
    for (const dropdown of this.querySelectorAll<HTMLElement & { open: boolean }>(
      "wa-dropdown[open]",
    )) {
      dropdown.open = false;
    }
  }

  private renderAgentSelect() {
    return renderAgentSelect({
      agents: this.place.agents(),
      agentId: this.place.agentId,
      disabled: this.submission.submitting || Boolean(this.submission.pendingCloud.sessionKey),
      onSelect: (agentId) => this.place.selectAgentId(agentId),
    });
  }

  private renderTargetBar() {
    const agents = this.place.agents();
    return catalog.renderBar({
      data: this.data,
      agentSelect: agents.length > 1 ? this.renderAgentSelect() : nothing,
      placeSelect: this.renderPlaceSelect(),
      retrying: this.gateway.catalogRetrying,
      onRetry: this.gateway.handleCatalogRetry,
    });
  }

  private renderPlaceSelect() {
    const execNodes = this.place.execNodes();
    const cloudProfiles = catalog.isTarget(this.data) ? [] : this.gateway.cloudProfiles;
    const branches = this.place.repository.kind === "git" ? this.place.repository : null;
    return renderPlaceSelect({
      browseAvailable: this.place.browseAvailable(),
      isAdmin: this.place.isAdmin(),
      canWrite: this.place.canWrite(),
      folder: this.place.folder,
      workspace: this.place.workspacePath(),
      projects: catalog.isTarget(this.data) ? [] : this.browser.projects,
      recents: catalog.isTarget(this.data)
        ? []
        : this.browser.resolveProjectRecents({
            sessions: this.context?.sessions.state.result?.sessions ?? [],
            workspace: this.place.workspacePath(),
            workspaceRoots: this.place.knownWorkspaceRoots(),
            execNodes,
            isAdmin: this.place.isAdmin(),
          }),
      projectQuery: this.browser.projectQuery,
      projectSearchAvailable: canCallGatewayMethod(
        this.context?.gateway.snapshot,
        "projects.searchRemote",
        "operator.read",
      ),
      projectAddAvailable: canCallGatewayMethod(
        this.context?.gateway.snapshot,
        "projects.add",
        "operator.write",
      ),
      remoteProjects: this.browser.projectSearchResult?.projects ?? [],
      projectSearchCredential: this.browser.projectSearchResult?.credential ?? null,
      projectSearchLoading: this.browser.projectSearchLoading,
      projectSearchError: this.browser.projectSearchError,
      projectCloneBusy: this.browser.projectCloneBusy,
      projectCloneError: this.browser.projectCloneError,
      projectId: this.place.projectId,
      execNodes: this.place.isAdmin() ? execNodes : [],
      environments: this.place.isAdmin() ? this.gateway.environments : [],
      gatewayName: this.gateway.gatewayName,
      cloudProfiles: this.place.isAdmin() ? cloudProfiles : [],
      cloudProfileId: this.place.cloudProfileId,
      execNode: this.place.execNode,
      syncFolder: this.place.folder.trim() || this.place.workspacePath(),
      worktree: this.place.worktree,
      worktreeVisible:
        this.place.worktreeAvailable() || Boolean(this.place.cloudProfileId) || this.place.worktree,
      worktreeAvailable: this.place.worktreeAvailable(),
      worktreeDisabledReason:
        this.place.repository.kind === "checking"
          ? t("newSession.checkingGit")
          : this.place.repository.kind === "unavailable"
            ? t("newSession.gitCheckUnavailable")
            : undefined,
      cloudDisabledReason: this.submission.cloudDisabledReason(),
      branches,
      branchesLoading: this.place.repository.kind === "checking",
      baseRef: this.place.baseRef,
      worktreeName: this.place.worktreeName,
      submitting: this.submission.submitting || this.browser.projectCloneBusy,
      pendingCloud: Boolean(this.submission.pendingCloud.sessionKey),
      showDestinations:
        Boolean(this.place.execNode) ||
        Boolean(this.place.cloudProfileId) ||
        (this.place.isAdmin() && (execNodes.length > 0 || cloudProfiles.length > 0)),
      popoverOpen: this.browser.placePopoverOpen,
      popoverHiding: this.browser.placePopoverHiding,
      browserTarget: this.browser.browserTarget,
      browserListing: this.browser.browserListing,
      browserLoading: this.browser.browserLoading,
      browserError: this.browser.browserError,
      browserPathDraft: this.browser.browserPathDraft,
      usableBrowserPath: this.browser.usableBrowserPath(),
      registerProjectPath: this.browser.browserProjectPath,
      registeringProject: this.browser.browserRegistering,
      onGuardTransition: (event) => this.browser.guardPopoverTransition(event),
      onPopoverShow: () => this.browser.onPopoverShow(),
      onPopoverHide: () => this.browser.onPopoverHide(),
      onPopoverAfterHide: () => this.browser.onPopoverAfterHide(),
      onSelectExecNode: (nodeId) => this.place.selectExecNode(nodeId),
      onSelectCloudProfile: (profileId) => this.place.selectCloudProfile(profileId),
      onSelectProject: (projectId) => this.place.selectProjectId(projectId),
      onProjectQueryInput: (query) => this.browser.changeProjectQuery(query),
      onCloneProject: (gitUrl) => void this.browser.addRemoteProject(gitUrl),
      onApplyFolder: (folder, execNode) =>
        this.place.applyFolder(
          folder,
          execNode,
          !execNode && this.browser.browserListing?.path === folder,
        ),
      onBrowse: (target) => this.browser.selectBrowserTarget(target),
      onBrowserPathDraftChange: (value) => {
        this.browser.browserPathDraft = value;
      },
      onBrowserNavigate: (path) => this.browser.loadBrowser(path),
      onBrowserBack: () => this.browser.showRoot(),
      onRegisterProject: (path) => void this.browser.registerBrowserProject(path),
      onClose: () => this.browser.close(),
      onToggleWorktree: () => this.place.toggleWorktree(),
      onBaseRefInput: (baseRef) => this.place.setBaseRef(baseRef),
      onWorktreeNameInput: (worktreeName) => this.place.setWorktreeName(worktreeName),
    });
  }

  private renderDraftBlock() {
    const worktreeNameInvalid =
      this.place.worktree && !isWorktreeNameValid(this.place.worktreeName);
    return html`
      <div class="new-session-page__draft" aria-busy=${String(this.submission.submitting)}>
        ${this.renderTargetBar()}
        ${worktreeNameInvalid ? renderDraftError(t("newSession.worktreeNameInvalid")) : nothing}
        ${this.submission.error ? renderDraftError(this.submission.error) : nothing}
        ${this.submission.submissionOutcomeUnknown
          ? renderDraftError(
              t(
                this.submission.submissionOutcomeUnknown === "gateway-changed"
                  ? "newSession.createOutcomeUnknown"
                  : "newSession.cloudSetupInterrupted",
              ),
            )
          : nothing}
        ${renderNewSessionDraftComposer({
          agent: this.place.selectedAgent(),
          agentId: this.place.agentId,
          attachmentDraft: this.submission.attachmentDraft,
          canSubmit: this.submission.canSubmit(),
          submitDisabledReason: this.submission.submitDisabledReason(),
          context: this.context,
          isCatalogTarget: catalog.isTarget(this.data),
          message: this.submission.message,
          visibility: this.submission.visibility,
          draftAvailable: this.submission.canStartAsDraft(),
          modelControl: this.place.modelControl,
          requiresModifier: loadSettings().chatSendShortcut === "modifier-enter",
          submitting: this.submission.submitting,
          textareaController: this.submission.composerTextarea,
          messageLocked: Boolean(this.submission.pendingCloud.sessionKey),
          incognitoDisabledReason: this.submission.incognitoDisabledReason(),
          terminalAction: this.submission.showStartInTerminal()
            ? {
                canStart: this.submission.canSubmit("terminal"),
                disabledReason: this.submission.terminalStartDisabledReason(),
                onStart: () => void this.submission.startInTerminal(),
              }
            : undefined,
          onInput: (message) => {
            if (!this.submission.submitting && !this.submission.pendingCloud.sessionKey) {
              this.setMessageFromUser(message);
            }
          },
          onVisibilityChange: (visibility) => {
            if (!this.submission.submitting && !this.submission.pendingCloud.sessionKey) {
              this.submission.setVisibility(visibility);
            }
          },
          onSubmit: () => void this.submission.submit(),
        })}
      </div>
    `;
  }

  private renderWelcome() {
    const agent = this.place.selectedAgent();
    const identity = agent?.identity;
    const gateway = this.context?.gateway.snapshot;
    return renderWelcomeState({
      assistantName: identity?.name ?? agent?.name ?? agent?.id ?? "",
      assistantAvatar: identity?.avatar ?? identity?.emoji ?? null,
      assistantAvatarUrl: identity?.avatarUrl ?? null,
      hint: t("newSession.hint"),
      composer: this.renderDraftBlock(),
      modelSetupRequired: this.submission.requiresModelSetup(),
      onModelSetup: () => this.context?.navigate("model-setup"),
      sessions: this.context?.sessions.state.result,
      sessionKey: buildAgentMainSessionKey({
        agentId: this.place.agentId || "main",
        mainKey: this.context?.agents.state.agentsList?.mainKey,
      }),
      sessionHost: {
        assistantAgentId: gateway?.assistantAgentId ?? null,
        agentsList: this.context?.agents.state.agentsList ?? null,
        hello: gateway?.hello ?? null,
      },
      onDraftChange: (next) => {
        if (!this.submission.submitting && !this.submission.pendingCloud.sessionKey) {
          this.setMessageFromUser(next);
        }
      },
      onSend: () => void this.submission.submit(),
      onOpenSession: (sessionKey) => {
        if (this.submission.submitting || this.submission.pendingCloud.sessionKey) {
          return;
        }
        const context = this.context;
        if (!context) {
          return;
        }
        selectApplicationSession({
          selection: context.agentSelection,
          gateway: context.gateway,
          sessionKey,
          agentId: this.place.agentId,
        });
        context.navigate(
          "chat",
          sessionNavigationTarget({ context, face: "chat", sessionKey }).options,
        );
      },
    });
  }

  override render() {
    return html`
      <div class="new-session-page">
        <div
          class="new-session-page__scroll"
          ?inert=${this.submission.submitting}
          aria-busy=${String(this.submission.submitting)}
          @mousedown=${beginNativeWindowDragFromTopInset}
        >
          ${this.renderWelcome()}
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-new-session-page")) {
  customElements.define("openclaw-new-session-page", NewSessionPage);
}
