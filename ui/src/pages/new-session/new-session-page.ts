import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { loadSettings } from "../../app/settings.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import "../../components/web-awesome-popover.ts";
import { normalizeAgentTargetLabel } from "../../lib/agents/display.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat.css";
import "../../styles/new-session.css";
import { renderChatImageLightbox } from "../chat/components/chat-image-lightbox.ts";
import { renderChatPermissionPicker } from "../chat/components/chat-permission-picker.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import * as catalog from "./catalog-target.ts";
import { NewSessionDictationControl } from "./composer-dictation-control.ts";
import { renderDraftError } from "./composer.ts";
import { ConnectMachineSetupState, renderConnectMachineDialog } from "./connect-machine-dialog.ts";
import { isWorktreeNameValid } from "./create-params.ts";
import { renderDetailChip, resolveDetailChip } from "./detail-chip.ts";
import { renderNewSessionDraftComposer } from "./draft-composer.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import * as drafts from "./draft-navigation-handoff.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import {
  renderNewSessionIncognitoControl,
  renderNewSessionIncognitoNotice,
} from "./incognito-control.ts";
import type { NewSessionRouteData } from "./location.ts";
import {
  closeAgentPicker,
  closeSessionMenus,
  createControllerHost,
  handleSessionPickerEvent,
  isPlaceTopologyEvent,
  presenceStateSignature,
} from "./new-session-runtime.ts";
import { renderProjectChip, resolveProjectChip } from "./project-chip.ts";
import type { SubmissionOutcomeReason } from "./session-placement-recovery-state.ts";
import { renderAgentSelect } from "./target-controls.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

const { activateDraft, restoreDraft, restoreDraftOwner, retainDraft } = drafts;

export class NewSessionPage extends OpenClawLightDomElement {
  @property({ attribute: false }) data: NewSessionRouteData | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  private openedFor: string | null = null;
  private openedGroupDefaults = "";
  private openedAgentId = "";
  private messageOwnerKey = "";
  private presenceSignature = "";
  private readonly connectMachine: ConnectMachineSetupState;
  @state() private imageLightbox: ImageLightboxItem | null = null;
  private readonly groupRouteRevalidation = new catalog.GroupRouteRevalidation(
    () => this.data,
    () => this.context?.revalidate("new-session"),
  );
  private readonly gateway: DraftGatewayState;
  private readonly browser: DraftPlaceBrowser;
  private readonly place: DraftPlaceState;
  private readonly submission: DraftSubmissionFlow;
  private readonly dictation: NewSessionDictationControl;
  private readonly subscriptions: SubscriptionsController;
  private readonly flushDraft = () => this.submission.draftPersistence.persistNow();

  constructor() {
    super();
    const host = createControllerHost(this);
    this.gateway = new DraftGatewayState(
      host,
      () => ({
        context: this.context,
        data: this.data,
        isConnected: this.isConnected,
        isAdmin: this.place?.isAdmin() ?? false,
        canStartAsDraft: this.submission?.capabilities.canStartAsDraft(this.context) ?? false,
        visibility: this.submission?.visibility ?? "normal",
        cloudProfileId: this.place?.cloudProfileId ?? "",
        pendingPlacement: this.submission?.pendingPlacement ?? {
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
        onPendingPlacementReset: () => this.submission.releasePendingPlacementOwner(),
        onRecoveryReady: (gatewayUrl, recoveryScope) =>
          restoreDraftOwner(this.submission, gatewayUrl, recoveryScope),
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
        isAdmin: this.place?.isAdmin() ?? false,
      }),
      {
        requestUpdate: () => this.requestUpdate(),
        onProjectMissing: () => this.place.clearProjectSelection(),
        onSelectProject: (projectId) => this.place.selectProjectId(projectId),
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
        pendingPlacementSessionKey: this.submission?.pendingPlacement.sessionKey ?? "",
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
        closeTransientUi: () => closeSessionMenus(this),
      },
    );
    this.connectMachine = new ConnectMachineSetupState(
      () => ({ client: this.gateway.client, connected: this.gateway.connected }),
      () => this.requestUpdate(),
    );
    this.dictation = new NewSessionDictationControl({
      textarea: this.submission.composerTextarea,
      getClient: () => this.gateway.client,
      isConnected: () => this.gateway.connected,
      canCommit: () => !this.submission.submitting && !this.submission.pendingPlacement.sessionKey,
      onMessage: (message) => this.setMessageFromUser(message),
      onError: (message) => this.submission.setError(message),
      onSubmit: () => void this.submission.submit(),
      requestUpdate: () => this.requestUpdate(),
    });
    this.subscriptions = new SubscriptionsController(this)
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.gateway.synchronize(gateway),
      )
      .effect(
        () => this.context?.gateway,
        (gateway) => {
          this.presenceSignature = presenceStateSignature(
            readPresenceEntries(gateway.snapshot.hello?.snapshot) ?? [],
          );
          return gateway.subscribeEvents((event) => {
            if (this.context?.gateway !== gateway) {
              return;
            }
            if (isPlaceTopologyEvent(event.event)) {
              this.refreshPlaceTopology();
              return;
            }
            const presence = event.event === "presence" ? readPresenceEntries(event.payload) : null;
            if (!presence) {
              return;
            }
            const signature = presenceStateSignature(presence);
            if (signature !== this.presenceSignature) {
              this.presenceSignature = signature;
              this.refreshPlaceTopology();
            }
          });
        },
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.agentIdentity,
        (agentIdentity, notify) => agentIdentity.subscribe(notify),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        (sessions) => this.groupRouteRevalidation.synchronize(sessions),
      )
      .watch(
        () => this.context?.config,
        (config, notify) => config.subscribe(() => notify()),
      );
  }

  private refreshPlaceTopology() {
    void this.gateway.refreshCloudProfiles();
  }

  handleEvent(event: Event) {
    handleSessionPickerEvent(this, event);
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this, true);
    document.addEventListener("pointerdown", this, true);
    window.addEventListener("beforeunload", this.flushDraft);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this, true);
    document.removeEventListener("pointerdown", this, true);
    window.removeEventListener("beforeunload", this.flushDraft);
    retainDraft(this.context, this.submission, this.openedFor, this.messageOwnerKey);
    this.subscriptions.clear();
    this.gateway.invalidateDiscovery(
      true,
      this.submission.pendingPlacement.sessionKey ? "placement-interrupted" : "gateway-changed",
    );
    this.gateway.disconnect();
    this.browser.disconnect();
    this.submission.disconnect();
    this.dictation.dispose();
    this.connectMachine.close();
    super.disconnectedCallback();
  }

  override updated() {
    if (this.connectMachine.open && !this.place.isAdmin()) {
      this.connectMachine.close();
    }
    this.gateway.retryPendingCatalogTarget();
    void this.context?.agentIdentity.ensure(this.place.agents().map((agent) => agent.id));
    const agentState = this.context?.agents.state;
    const agentsReady = Boolean(
      this.gateway.connected &&
      this.gateway.client &&
      agentState?.connected &&
      agentState.client === this.gateway.client &&
      this.place.agents().length > 0,
    );
    this.place.modelControl.loadCatalogTargets(
      this.context,
      agentsReady && this.place.agentId ? (this.place.selectedAgent()?.id ?? "") : "",
      this.context?.config.current.cliAgentsEnabled === true && !catalog.isTarget(this.data),
    );
    const openKey = this.routeOwnerKey();
    const resolvedAgentId = this.data?.agentId ?? "";
    const groupDefaults = catalog.groupDefaultsKey(this.data);
    if (this.openedFor !== openKey) {
      const ownedMessage = this.messageOwnerKey === openKey ? this.submission.message : "";
      this.openedFor = openKey;
      this.openedGroupDefaults = groupDefaults;
      this.openedAgentId = resolvedAgentId;
      this.place.setAgentsHydrated(agentsReady);
      this.resetDraft();
      this.messageOwnerKey = restoreDraft(this.context, this.submission, openKey, ownedMessage);
      return;
    }
    if (this.openedGroupDefaults !== groupDefaults) {
      this.openedGroupDefaults = groupDefaults;
      this.place.adoptGroupDefaults();
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
    this.place.restorePreferenceSelections();
    activateDraft(this.submission, openKey);
    this.submission.resumeInterruptedSubmission();
  }

  private invalidateGatewayDiscovery(
    resetHostSelection: boolean,
    submissionOutcome: SubmissionOutcomeReason,
  ) {
    this.place.invalidateGatewayDiscovery(resetHostSelection);
    this.submission.attachmentDraft.abortReads();
    this.submission.invalidate(submissionOutcome);
    if (resetHostSelection && this.submission.pendingPlacement.sessionKey) {
      this.submission.markPendingPlacementUnavailable(submissionOutcome);
    }
    if (resetHostSelection) {
      this.submission.clearError();
    }
    this.connectMachine.close();
  }

  private resetDraft() {
    this.place.resetDraft();
    this.submission.resetDraft();
    this.messageOwnerKey = catalog.routeKey(this.data);
    this.browser.clearPopoverHiding();
    closeAgentPicker(this);
    this.browser.close();
    this.connectMachine.close();
    this.place.adoptAgentDefaults();
  }

  private routeOwnerKey(): string {
    return this.data
      ? catalog.routeKey(this.data)
      : catalog.routeKeyFromSearch(window.location.search);
  }

  private setMessage(message: string, ownerKey = catalog.routeKey(this.data)) {
    this.submission.setMessage(message);
    this.messageOwnerKey = ownerKey;
  }

  private setMessageFromUser(message: string) {
    if (!this.submission.submitting && !this.submission.pendingPlacement.sessionKey) {
      this.setMessage(message, catalog.routeKeyFromSearch(window.location.search));
    }
  }

  private renderAgentSelect() {
    return renderAgentSelect({
      agents: this.place.agents(),
      agentId: this.place.agentId,
      agentIdentity: this.context?.agentIdentity,
      disabled: this.submission.submitting || Boolean(this.submission.pendingPlacement.sessionKey),
      onSelect: (agentId) => this.place.selectAgentId(agentId),
    });
  }

  private renderTargetBar() {
    const agents = this.place.agents();
    const sessions = this.context?.sessions;
    return catalog.renderBar({
      data: this.data,
      groupPending: catalog.isGroupRoutePending(this.data, sessions),
      agentSelect: agents.length > 1 ? this.renderAgentSelect() : nothing,
      placeSelect: this.renderPlaceChips(),
      retrying:
        this.gateway.catalogRetrying ||
        Boolean(this.data?.group && sessions?.groupsStatus() === "loading"),
      onRetry: this.gateway.handleCatalogRetry,
    });
  }

  private renderPlaceChips() {
    const cloudProfiles =
      catalog.isTarget(this.data) || !this.place.isAdmin() ? [] : this.gateway.cloudProfiles;
    const branches = this.place.repository.kind === "git" ? this.place.repository : null;
    const projects = catalog.isTarget(this.data) ? [] : this.browser.projects;
    const recents = catalog.isTarget(this.data)
      ? []
      : this.browser.resolveProjectRecents({
          sessions: this.context?.sessions.state.result?.sessions ?? [],
          workspace: this.place.workspacePath(),
          workspaceRoots: this.place.knownWorkspaceRoots(),
          isAdmin: this.place.isAdmin(),
        });
    const whereState = resolveWhereChip({
      environments: this.place.canWrite() ? this.gateway.environments : [],
      cloudProfiles,
      cloudProfileId: this.place.cloudProfileId,
      machineClass: this.place.machineClass,
      deviceId: this.place.deviceId,
      autoDevice: this.place.autoDevice,
      devicePlacement: this.place.devicePlacementRequirement(),
      deviceDisabledReason:
        this.place.modelControl.devicePlacementUnsupportedReason() ??
        this.gateway.deviceCatalogDisabledReason,
    });
    const projectState = resolveProjectChip({
      folder: this.place.folder,
      workspace: this.place.workspacePath(),
      projectId: this.browser.projectId,
      selectedRemoteProject: this.browser.remoteProject,
      projects,
      recents,
      projectQuery: this.browser.projectQuery,
    });
    const detailState = resolveDetailChip({
      destination: this.place.remotePlacement ? "remote" : "local",
      worktree: this.place.worktree,
      worktreeAvailable: this.place.worktreeAvailable(),
    });
    const gatewayLabel = this.gateway.gatewayName
      ? t("newSession.gatewayNamed", { name: this.gateway.gatewayName })
      : t("newSession.gateway");
    const submitting = this.submission.submitting;
    const pendingPlacement = Boolean(this.submission.pendingPlacement.sessionKey);
    return html`${renderWhereChip({
      state: whereState,
      gatewayName: this.gateway.gatewayName,
      cloudProfileId: this.place.cloudProfileId,
      machineClass: this.place.machineClass,
      deviceId: this.place.deviceId,
      autoDevice: this.place.autoDevice,
      autoPlacementMode: this.place.modelControl.autoPlacementSelectionMode(),
      worktreeAvailable: this.place.worktreeAvailable(),
      cloudDisabledReason: this.submission.cloudDisabledReason(),
      cloudProfileDisabledReason: (profile) =>
        this.place.modelControl.cloudRuntimeUnsupportedReason(profile),
      submitting,
      pendingPlacement,
      isAdmin: this.place.isAdmin(),
      ...this.browser.popoverCallbacks("where"),
      onSelectDevice: (deviceId) => this.place.selectDevice(deviceId),
      onSelectAutoDevice: () => this.place.selectDevice("", true),
      onSelectCloudProfile: (profileId) => this.place.selectCloudProfile(profileId),
      onSelectCloudMachine: (machineId) =>
        this.place.cloudMachines.select(
          this.place.cloudProfileId,
          machineId,
          cloudProfiles,
          submitting || pendingPlacement,
          () => this.requestUpdate(),
        ),
      onConnectMachine: () => this.openConnectMachine(),
    })}${renderProjectChip({
      state: projectState,
      browseAvailable: this.place.browseAvailable(),
      isAdmin: this.place.isAdmin(),
      canWrite: this.place.canWrite(),
      folder: this.place.folder,
      workspace: this.place.workspacePath(),
      projects,
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
      selectedRemoteProject: this.browser.remoteProject,
      projectSearchCredentialMissing: this.browser.projectSearchResult?.credential === "missing",
      projectSearchLoading: this.browser.projectSearchLoading,
      projectSearchError: this.browser.projectSearchError,
      projectId: this.browser.projectId,
      gatewayLabel,
      remotePlacement: this.place.remotePlacement,
      branches,
      branchesLoading: this.place.repository.kind === "checking",
      baseRef: this.place.baseRef,
      worktreeName: this.place.worktreeName,
      submitting,
      pendingPlacement,
      ...this.browser.popoverCallbacks("project"),
      browserOpen: this.browser.browserOpen,
      browserListing: this.browser.browserListing,
      browserLoading: this.browser.browserLoading,
      browserError: this.browser.browserError,
      browserPathDraft: this.browser.browserPathDraft,
      usableBrowserPath: this.browser.usableBrowserPath(),
      registerProjectPath: this.browser.browserProjectPath,
      registeringProject: this.browser.browserRegistering,
      onSelectProject: (projectId) => this.place.selectProjectId(projectId),
      onProjectQueryInput: (query) => this.browser.changeProjectQuery(query),
      onSelectRemoteProject: (project) => this.place.selectRemoteProject(project),
      onApplyFolder: (folder) =>
        this.place.applyFolder(folder, this.browser.browserListing?.path === folder),
      onBaseRefInput: (baseRef) => this.place.setBaseRef(baseRef),
      onWorktreeNameInput: (worktreeName) => this.place.setWorktreeName(worktreeName),
      onBrowse: () =>
        this.browser.selectGatewayBrowser(this.place.folder.trim() || this.place.workspacePath()),
      onBrowserPathDraftChange: (value) => {
        this.browser.browserPathDraft = value;
      },
      onBrowserNavigate: (path) => this.browser.loadBrowser(path),
      onBrowserBack: () => this.browser.showRoot(),
      onRegisterProject: (path) => void this.browser.registerBrowserProject(path),
      onClose: () => this.browser.close(),
    })}${detailState
      ? renderDetailChip({
          state: detailState,
          worktree: this.place.worktree,
          worktreeAvailable: this.place.worktreeAvailable(),
          repositoryUnavailable: this.place.repository.kind === "unavailable",
          branches,
          branchesLoading: this.place.repository.kind === "checking",
          baseRef: this.place.baseRef,
          worktreeName: this.place.worktreeName,
          submitting,
          pendingPlacement,
          ...this.browser.popoverCallbacks("detail"),
          onToggleWorktree: () => this.place.toggleWorktree(),
          onBaseRefInput: (baseRef) => this.place.setBaseRef(baseRef),
          onWorktreeNameInput: (worktreeName) => this.place.setWorktreeName(worktreeName),
        })
      : nothing}`;
  }

  private openConnectMachine() {
    if (!this.place.isAdmin()) {
      return;
    }
    this.browser.close();
    this.connectMachine.start();
  }

  private renderDraftBlock() {
    const worktreeNameInvalid =
      this.place.worktree && !isWorktreeNameValid(this.place.worktreeName);
    const capabilities = this.submission.capabilities;
    const voiceControl = this.dictation.render(this.routeOwnerKey());
    const dictationLocked = this.dictation.active;
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
                  : "newSession.placementSetupInterrupted",
              ),
              this.submission.pendingPlacement.sessionKey
                ? {
                    label: t("common.reset"),
                    onClick: () => this.submission.clearPendingPlacementRecovery(),
                  }
                : undefined,
            )
          : nothing}
        ${renderNewSessionDraftComposer({
          agent: this.place.selectedAgent(),
          agentId: this.place.agentId,
          attachmentDraft: this.submission.attachmentDraft,
          canSubmit: !this.submission.submitting && !dictationLocked && this.submission.canSubmit(),
          submitDisabledReason: this.submission.submitDisabledReason(),
          blockedSubmitNotice: this.submission.blockedSubmitNotice(),
          dictationActive: this.dictation.active,
          dictationPreview: this.dictation.previewDraft(),
          dictationStatus: this.dictation.renderStatus(),
          context: this.context,
          isCatalogTarget: catalog.isTarget(this.data),
          draftOwnerKey: this.routeOwnerKey(),
          message: this.submission.message,
          visibility: this.submission.visibility,
          draftAvailable: capabilities.canStartAsDraft(this.context),
          ...capabilities.composerProps(this.context, this.gateway, this.place.agentId),
          modelControl: this.place.modelControl,
          permissionControl: catalog.isTarget(this.data)
            ? undefined
            : renderChatPermissionPicker({
                canSelectFull: this.place.isAdmin(),
                defaultMode: this.place.selectedAgent()?.defaultPermissionMode,
                disabled:
                  this.submission.submitting ||
                  Boolean(this.submission.pendingPlacement.sessionKey),
                disabledReason: this.submission.submitting ? t("newSession.starting") : undefined,
                mode: this.submission.permission.value,
                onSelect: (permissionMode) =>
                  this.submission.permission.set(permissionMode ?? undefined),
              }),
          requiresModifier: loadSettings().chatSendShortcut === "modifier-enter",
          requestUpdate: () => this.requestUpdate(),
          submitting: this.submission.submitting,
          textareaController: this.submission.composerTextarea,
          voiceControl,
          messageLocked: Boolean(this.submission.pendingPlacement.sessionKey),
          terminalAction: this.submission.showStartInTerminal()
            ? {
                canStart:
                  !this.submission.submitting &&
                  !dictationLocked &&
                  this.submission.canSubmit("terminal"),
                disabledReason: this.submission.submitBlock("terminal")?.reason,
                onStart: () => void this.submission.startInTerminal(),
              }
            : undefined,
          onInput: (message) => this.setMessageFromUser(message),
          onOpenImage: (item) => {
            this.imageLightbox = item;
          },
          onVisibilityChange: (visibility) => {
            if (!this.submission.submitting && !this.submission.pendingPlacement.sessionKey) {
              this.submission.setVisibility(visibility);
            }
          },
          onSubmit: () => void this.submission.submit(),
        })}
        ${renderNewSessionIncognitoNotice(this.submission.visibility === "incognito")}
      </div>
    `;
  }

  private renderWelcome() {
    const agent = this.place.selectedAgent();
    const identity = this.context?.agentIdentity.get(this.place.agentId);
    const gateway = this.context?.gateway.snapshot;
    return renderWelcomeState({
      assistantName: agent ? normalizeAgentTargetLabel(agent, identity) : "",
      assistantAvatar: agent?.identity?.avatar ?? agent?.identity?.emoji ?? null,
      assistantAvatarUrl: agent?.identity?.avatarUrl ?? null,
      hint: t("newSession.hint"),
      composer: this.renderDraftBlock(),
      hideSecondaryContent: this.submission.visibility === "incognito",
      fadeSecondaryContent: this.submission.message.trim().length > 0,
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
      onDraftChange: (next) => this.setMessageFromUser(next),
      onSend: () => void this.submission.submit(),
      onOpenSession: (sessionKey) => {
        if (this.submission.submitting || this.submission.pendingPlacement.sessionKey) {
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
      <div
        class="new-session-page ${this.submission.visibility === "incognito"
          ? "new-session-page--incognito"
          : ""}"
      >
        ${renderNewSessionIncognitoControl(
          this.submission,
          this.submission.capabilities.canStartAsDraft(this.context),
        )}
        <div
          class="new-session-page__scroll"
          ?inert=${this.submission.submitting}
          aria-busy=${String(this.submission.submitting)}
          @mousedown=${beginNativeWindowDragFromTopInset}
        >
          ${this.renderWelcome()}
        </div>
        ${renderConnectMachineDialog({
          open: this.connectMachine.open && this.place.isAdmin(),
          loading: this.connectMachine.loading,
          error: this.connectMachine.error,
          setup: this.connectMachine.setup,
          onRefresh: () => void this.connectMachine.refresh(),
          onClose: () => {
            this.connectMachine.close();
            this.requestUpdate();
          },
          onManageDevices: () => {
            this.connectMachine.close();
            this.context?.navigate("devices");
          },
        })}
        ${renderChatImageLightbox(this.imageLightbox, () => {
          this.imageLightbox = null;
        })}
      </div>
    `;
  }
}
