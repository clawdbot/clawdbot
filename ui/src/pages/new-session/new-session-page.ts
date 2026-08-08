import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  FsListDirResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { loadSettings } from "../../app/settings.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat.css";
import "../../styles/new-session.css";
import { buildChatApiAttachments, restoreChatApiAttachments } from "../chat/attachment-api.ts";
import { requiresChatModelSetup } from "../chat/chat-model-setup.ts";
import { clearChatModelSearchOnEscape } from "../chat/components/chat-model-picker.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import { prepareInitialUserMessageHandoff } from "../chat/initial-turn-handoff.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import * as catalog from "./catalog-target.ts";
import {
  CLOUD_PROFILE_RETRY_DELAYS_MS,
  discoverCloudProfiles,
  selectProfiles,
} from "./cloud-profile-discovery.ts";
import { PendingCloudRecoveryState, resolveScope } from "./cloud-recovery-state.ts";
import { advanceCloudDraftSession } from "./cloud-submit.ts";
import {
  NewSessionComposerTextareaController,
  renderDraftError,
  renderNewSessionDraftComposer,
} from "./composer.ts";
import {
  buildDraftSessionCreateParams,
  canStartSessionAsDraft,
  isWorktreeNameValid,
  type NewSessionVisibility,
} from "./create-params.ts";
import {
  type BrowserTarget,
  type DraftCloudProfile,
  type DraftNode,
  type DraftRepositoryState,
  readDraftNodes,
} from "./discovery.ts";
import { isMissingRestoredFolderError } from "./folder-validation.ts";
import { discoverGatewayName } from "./gateway-name-discovery.ts";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { isAbsolutePath } from "./path.ts";
import { renderPlaceSelect } from "./place-picker.ts";
import {
  loadNewSessionPreference,
  patchNewSessionPreference,
  type NewSessionPreference,
} from "./preferences.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import { renderAgentSelect } from "./target-controls.ts";

const CATALOG_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

class NewSessionPage extends OpenClawLightDomElement {
  @property({ attribute: false }) data: NewSessionRouteData | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private agentId = "";
  @state() private folder = "";
  @state() private worktree = false;
  @state() private visibility: NewSessionVisibility = "normal";
  @state() private worktreeName = "";
  @state() private baseRef = "";
  @state() private repository: DraftRepositoryState = { kind: "idle" };
  @state() private nodes: DraftNode[] = [];
  @state() private gatewayName = "";
  @state() private execNode = "";
  @state() private cloudProfiles: DraftCloudProfile[] = [];
  @state() private cloudProfilesReady = false;
  @state() private cloudProfileId = "";
  @state() private message = "";
  @state() private submitting = false;
  @state() private submissionOutcomeUnknown = false;
  @state() private error: string | null = null;
  @state() private catalogRetrying = false;
  @state() private browserLoading = false;
  @state() private browserError: string | null = null;
  @state() private browserListing: FsListDirResult | null = null;
  @state() private browserTarget: BrowserTarget | null = null;
  @state() private placePopoverOpen = false;
  @state() private placePopoverHiding = false;
  // Live head input; absolute paths stay applicable even without fs.listDir.
  @state() private browserPathDraft = "";
  @state() private restoredFolderValidation: "none" | "checking" | "failed" = "none";

  private openedFor: string | null = null;
  private openedAgentId = "";
  private agentsHydrated = false;
  private nodesHydrated = false;
  // Discovery retry provenance separates user choices from Gateway-derived defaults.
  private agentSelectedByUser = false;
  private folderSelectedByUser = false;
  private preferredWorktreeRestore = false;
  private worktreeSelectedByUser = false;
  private submitRequestToken = 0;
  private nodesRequestToken = 0;
  private readonly pendingCloud = new PendingCloudRecoveryState();
  private branchesRequestToken = 0;
  private baseRefEditGeneration = 0;
  private browserRequestToken = 0;
  private restoredFolderValidationToken = 0;
  private readonly attachmentDraft = new NewSessionAttachmentDraft(() => this.requestUpdate());
  private readonly composerTextarea = new NewSessionComposerTextareaController();
  private readonly modelControl = new NewSessionModelControl(
    () => this.requestUpdate(),
    (selection) => this.persistPreference(selection),
  );
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private gatewayClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private gatewayUrl = "";
  private gatewayRecoveryScope = "";
  private gatewayRecoveryScopeReady = false;
  private gatewayConnected = false;
  private gatewayConnectionEpoch = 0;
  private catalogRetryScope = "";
  private catalogRetryAttempt = 0;
  private catalogRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private cloudProfileRetryAttempt = 0;
  private cloudProfileRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  // Re-render when agents/sessions hydrate so the hero identity and the
  // recent-chats list appear without a route change.
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.synchronizeGateway(gateway),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    );

  private readonly gatewayNameTask = new Task(this, {
    args: () =>
      [
        this.isConnected && this.gatewayConnected ? this.gatewayClient : null,
        this.context
          ? isGatewayMethodAdvertised(this.context.gateway.snapshot, "system.info") === true
          : false,
        this.gatewayConnectionEpoch,
      ] as const,
    task: ([client, advertised, _connectionEpoch], { signal }) =>
      discoverGatewayName(client, advertised, signal),
    onComplete: (name) => {
      this.gatewayName = name;
    },
  });

  private readonly cloudProfileTask = new Task(this, {
    args: () =>
      [
        this.isConnected && this.gatewayConnected ? this.gatewayClient : null,
        this.gatewayConnectionEpoch,
        this.isAdmin(),
        this.gatewayRecoveryScope,
      ] as const,
    task: ([client, _connectionEpoch, admin]) =>
      client ? discoverCloudProfiles(client, admin) : initialState,
    onComplete: (profiles) => {
      this.resetCloudProfileRetry();
      this.applyCloudProfiles(profiles);
      this.cloudProfilesReady = true;
    },
    onError: () => {
      this.cloudProfiles = [];
      this.cloudProfilesReady = false;
      this.scheduleCloudProfileRetry();
    },
  });

  private applyCloudProfiles(profiles: DraftCloudProfile[]) {
    const recovery = selectProfiles(profiles, this.gatewayClient, this.gatewayRecoveryScope);
    this.cloudProfiles = recovery.profiles;
    const pendingCloud = Boolean(this.pendingCloud.sessionKey);
    if ((!this.gatewayConnected || !this.isAdmin()) && !pendingCloud) {
      this.cloudProfileId = "";
      this.closeBrowser();
    }
    const selectionUnavailable =
      !pendingCloud &&
      Boolean(this.cloudProfileId) &&
      !profiles.some((profile) => profile.id === this.cloudProfileId);
    if (selectionUnavailable) {
      this.error = t("newSession.catalogUnavailable");
    } else if (recovery.unsupported) {
      this.error = t("newSession.cloudSecureContextRequired");
    } else if (this.error === t("newSession.cloudSecureContextRequired")) {
      this.error = null;
    }
  }

  private resetCloudProfileRetry() {
    globalThis.clearTimeout(this.cloudProfileRetryTimer);
    this.cloudProfileRetryTimer = undefined;
    this.cloudProfileRetryAttempt = 0;
  }

  private scheduleCloudProfileRetry() {
    if (this.cloudProfileRetryTimer || !this.gatewayConnected || !this.gatewayClient) {
      return;
    }
    if (this.cloudProfileRetryAttempt >= CLOUD_PROFILE_RETRY_DELAYS_MS.length) {
      this.applyCloudProfiles([]);
      this.cloudProfilesReady = true;
      return;
    }
    const delayMs = CLOUD_PROFILE_RETRY_DELAYS_MS[this.cloudProfileRetryAttempt];
    this.cloudProfileRetryAttempt += 1;
    this.cloudProfileRetryTimer = globalThis.setTimeout(() => {
      this.cloudProfileRetryTimer = undefined;
      if (this.gatewayConnected) {
        void this.cloudProfileTask.run();
      }
    }, delayMs);
  }

  private synchronizeGateway(gateway: ApplicationContext["gateway"]) {
    const snapshot = gateway.snapshot;
    const connected = snapshot.phase === "connected";
    const firstBind = this.gatewaySource === null;
    const gatewayUrlChanged = !firstBind && this.gatewayUrl !== gateway.connection.gatewayUrl;
    const identityChanged =
      !firstBind && (this.gatewaySource !== gateway || this.gatewayClient !== snapshot.client);
    const connectionChanged = !firstBind && this.gatewayConnected !== connected;
    const becameConnected = connected && (identityChanged || !this.gatewayConnected);
    const recoveryScopeBecameReady =
      connected && snapshot.client?.recoveryScopeReady === true && !this.gatewayRecoveryScopeReady;
    const recoveryScope = resolveScope(
      { client: snapshot.client, connected },
      this.gatewayRecoveryScope,
      firstBind,
    );
    this.gatewaySource = gateway;
    this.gatewayClient = snapshot.client;
    this.gatewayUrl = gateway.connection.gatewayUrl;
    this.gatewayRecoveryScope = recoveryScope.next;
    this.gatewayRecoveryScopeReady = snapshot.client?.recoveryScopeReady === true;
    this.gatewayConnected = connected;
    if (this.visibility === "draft" && !this.canStartAsDraft()) {
      this.visibility = "normal";
    }
    if (gatewayUrlChanged || identityChanged || connectionChanged || recoveryScope.changed) {
      this.invalidateGatewayDiscovery(gatewayUrlChanged || recoveryScope.changed);
    }
    if (
      firstBind ||
      gatewayUrlChanged ||
      recoveryScope.changed ||
      recoveryScopeBecameReady ||
      becameConnected
    ) {
      if (
        this.pendingCloud.gatewayUrl &&
        (this.pendingCloud.gatewayUrl !== this.gatewayUrl ||
          this.pendingCloud.recoveryScope !== this.gatewayRecoveryScope)
      ) {
        this.pendingCloud.reset();
        this.submissionOutcomeUnknown = false;
      }
      if (connected && snapshot.client?.recoveryScopeReady) {
        this.restorePendingCloudRecovery(this.gatewayUrl, this.gatewayRecoveryScope);
      }
    }
    if (becameConnected || recoveryScope.changed) {
      if (becameConnected) {
        this.gatewayConnectionEpoch += 1;
        this.retryPendingCatalogTarget();
      }
    }
  }

  private invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.nodesRequestToken += 1;
    this.nodesHydrated = false;
    this.gatewayName = "";
    this.cloudProfiles = [];
    this.cloudProfilesReady = false;
    this.resetCloudProfileRetry();
    this.branchesRequestToken += 1;
    this.repository = { kind: "idle" };
    this.baseRef = ""; // Never carry a derived ref across a transport epoch.
    this.agentsHydrated = false;
    this.modelControl.invalidate(resetHostSelection);
    this.attachmentDraft.abortReads();
    this.closeBrowser();
    this.cancelRestoredFolderValidation();
    this.invalidateSubmission(true); // Transport loss makes an in-flight create outcome unknowable.
    if (!resetHostSelection) {
      return;
    }
    if (this.pendingCloud.sessionKey) {
      // Keep the original Gateway identity so a failed teardown cannot hide a worker elsewhere.
      this.pendingCloud.retryAllowed = false;
      this.submissionOutcomeUnknown = true;
    }
    // A replacement client may target another Gateway. Keep the user's task,
    // but retire every selection and discovery result owned by the old host.
    this.agentId = "";
    this.agentSelectedByUser = false;
    this.folder = "";
    this.folderSelectedByUser = false;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
    this.worktree = false;
    this.visibility = "normal";
    this.worktreeName = "";
    this.baseRefEditGeneration += 1;
    this.nodes = [];
    this.execNode = "";
    this.cloudProfileId = "";
    this.error = null;
  }

  private retryPendingCatalogTarget() {
    if (this.catalogRetrying) {
      return;
    }
    if (
      !this.gatewayConnected ||
      !catalog.isTarget(this.data) ||
      catalog.isResolvedTarget(this.data)
    ) {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      this.catalogRetryScope = "";
      this.catalogRetryAttempt = 0;
      return;
    }
    const retryScope = `${this.gatewayConnectionEpoch}:${catalog.routeKey(this.data)}`;
    if (this.catalogRetryScope !== retryScope) {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      this.catalogRetryScope = retryScope;
      this.catalogRetryAttempt = 0;
    }
    if (this.catalogRetryTimer || this.catalogRetryAttempt >= CATALOG_RETRY_DELAYS_MS.length) {
      return;
    }
    const delayMs = CATALOG_RETRY_DELAYS_MS[this.catalogRetryAttempt];
    this.catalogRetryAttempt += 1;
    this.catalogRetryTimer = globalThis.setTimeout(() => {
      this.catalogRetryTimer = undefined;
      if (
        this.catalogRetryScope !== retryScope ||
        !this.gatewayConnected ||
        !catalog.isTarget(this.data) ||
        catalog.isResolvedTarget(this.data)
      ) {
        return;
      }
      const revalidation = this.context?.revalidate("new-session");
      if (!revalidation) {
        return;
      }
      void revalidation
        .catch(() => undefined)
        .then(() => this.updateComplete)
        .then(() => this.retryPendingCatalogTarget());
    }, delayMs);
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
      // Closing details does not move focus out of its now-hidden controls.
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
    // /new renders chat controls without ChatPane, so the route owns pointer
    // and Escape light-dismissal for both picker popovers.
    document.addEventListener("keydown", this, true);
    document.addEventListener("pointerdown", this, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this, true);
    document.removeEventListener("pointerdown", this, true);
    this.subscriptions.clear();
    // This invalidates submitRequestToken before payload release below, so a
    // late sessions.create result cannot navigate with attachments we no longer own.
    this.invalidateGatewayDiscovery(true);
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.gatewayConnectionEpoch = 0;
    this.catalogRetryScope = "";
    this.catalogRetryAttempt = 0;
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    this.attachmentDraft.reset({ release: true });
    this.composerTextarea.disconnect();
    void this.gatewayNameTask.run([null, false, -1]);
    void this.cloudProfileTask.run([null, -1, false, ""]);
    this.resetCloudProfileRetry();
    super.disconnectedCallback();
  }

  override updated() {
    this.retryPendingCatalogTarget();
    const agentState = this.context?.agents.state;
    const agentsReady = Boolean(
      this.gatewayConnected &&
      this.gatewayClient &&
      agentState?.connected &&
      agentState.client === this.gatewayClient &&
      this.agents().length > 0,
    );
    const openKey = catalog.routeKey(this.data);
    const resolvedAgentId = this.data?.agentId ?? "";
    if (this.openedFor !== openKey) {
      this.openedFor = openKey;
      this.openedAgentId = resolvedAgentId;
      this.agentsHydrated = agentsReady;
      this.resetDraft();
      return;
    }
    if (this.openedAgentId !== resolvedAgentId) {
      // The route named the target agent after the draft opened, so the page is
      // still holding the fallback agent it adopted while the id was unknown.
      this.openedAgentId = resolvedAgentId;
      this.agentsHydrated = false;
    }
    // A hard reload can land here before agents.list resolves. Once the list
    // arrives, adopt only agent-derived defaults; a full reset would discard
    // anything the user already typed while the list was loading.
    if (!this.agentsHydrated && agentsReady) {
      this.agentsHydrated = true;
      this.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
    }
  }

  private readonly handleCatalogRetry = () => {
    if (
      this.catalogRetrying ||
      !this.gatewayConnected ||
      !catalog.isTarget(this.data) ||
      catalog.isResolvedTarget(this.data)
    ) {
      return;
    }
    const revalidation = this.context?.revalidate("new-session");
    if (!revalidation) {
      return;
    }
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    this.catalogRetrying = true;
    void revalidation
      .catch(() => undefined)
      .then(() => this.updateComplete)
      .finally(() => {
        this.catalogRetrying = false;
        this.retryPendingCatalogTarget();
      });
  };

  private agents() {
    return listSelectableAgents(this.context?.agents.state.agentsList?.agents ?? []);
  }

  private selectedAgent() {
    const agentId = normalizeAgentId(this.agentId);
    return this.agents().find((agent) => normalizeAgentId(agent.id) === agentId);
  }

  private execNodes(): DraftNode[] {
    return this.nodes.filter((node) => node.canExec);
  }

  private isAdmin(): boolean {
    return hasOperatorAdminAccess(this.context?.gateway.snapshot.hello?.auth ?? null);
  }

  private canStartAsDraft(): boolean {
    return canStartSessionAsDraft({
      allowedVisibilities: this.context?.gateway.snapshot.hello?.policy?.allowedSessionVisibilities,
      hasMultipleIdentities:
        this.context?.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities,
    });
  }

  private workspacePath(): string {
    return normalizeOptionalString(this.selectedAgent()?.workspace) ?? "";
  }

  private usesCustomFolder(): boolean {
    const folder = this.folder.trim();
    return Boolean(folder) && folder !== this.workspacePath();
  }

  private buildCreateParamsForAccess(
    visibility: NewSessionVisibility = this.visibility,
  ): Record<string, unknown> {
    return buildDraftSessionCreateParams({
      agentId: this.agentId,
      message: "",
      model: this.modelControl.selected,
      thinkingLevel: this.modelControl.thinkingLevel,
      visibility,
      worktree: this.worktree,
      baseRef: this.baseRef,
      worktreeName: this.worktreeName,
      cwd: this.folder,
      workspace: this.workspacePath(),
      execNode: this.execNode,
      catalogId: this.data?.catalogId,
    });
  }

  private submissionAccess(
    createParams: Record<string, unknown> = this.pendingCloud.createParams ??
      this.buildCreateParamsForAccess(),
  ): SessionMethodAccess {
    const gateway = this.context?.gateway.snapshot;
    const pendingCloud = Boolean(this.pendingCloud.sessionKey);
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

  private submitDisabledReason(): string | undefined {
    const access = this.submissionAccess();
    return access.allowed ? undefined : access.reason;
  }

  private incognitoDisabledReason(): string | undefined {
    const access = readSessionMethodAccess(this.context?.gateway.snapshot, {
      method: "sessions.create",
      params: this.buildCreateParamsForAccess("incognito"),
    });
    return access.allowed ? undefined : access.reason;
  }

  private preference(): NewSessionPreference | null {
    if (catalog.isTarget(this.data) || this.pendingCloud.sessionKey) {
      return null;
    }
    return loadNewSessionPreference(this.gatewayUrl, this.agentId);
  }

  private persistPreference(patch: NewSessionPreference) {
    if (catalog.isTarget(this.data) || this.pendingCloud.sessionKey) {
      return;
    }
    patchNewSessionPreference(this.gatewayUrl, this.agentId, {
      workspace: this.workspacePath(),
      ...patch,
    });
  }

  private cancelRestoredFolderValidation() {
    this.restoredFolderValidationToken += 1;
    this.restoredFolderValidation = "none";
  }

  private validateRestoredFolder(folder: string) {
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client || !this.isAdmin()) {
      this.restoredFolderValidation = "checking";
      return;
    }
    const requestId = ++this.restoredFolderValidationToken;
    this.restoredFolderValidation = "checking";
    void client
      .request<FsListDirResult>("fs.listDir", { path: folder })
      .then(() => {
        if (
          requestId !== this.restoredFolderValidationToken ||
          this.folderSelectedByUser ||
          this.folder !== folder
        ) {
          return;
        }
        this.restoredFolderValidation = "none";
        if (this.error === t("newSession.browserLoadFailed")) {
          this.error = null;
        }
        this.maybeLoadBranches();
      })
      .catch((error: unknown) => {
        if (
          requestId !== this.restoredFolderValidationToken ||
          this.folderSelectedByUser ||
          this.folder !== folder
        ) {
          return;
        }
        if (isMissingRestoredFolderError(error)) {
          this.restoredFolderValidation = "none";
          if (this.error === t("newSession.browserLoadFailed")) {
            this.error = null;
          }
          this.folder = this.workspacePath();
          this.worktree = false;
          this.preferredWorktreeRestore = false;
          this.persistPreference({ folder: this.folder, worktree: false });
          this.maybeLoadBranches();
          return;
        }
        this.restoredFolderValidation = "failed";
        this.error = t("newSession.browserLoadFailed");
      });
  }

  private adoptAgentDefaults(
    options: { preserveSelectedAgent?: boolean; preserveSelectedFolder?: boolean } = {},
  ) {
    const agents = this.agents();
    const configuredDefault = this.context?.agents.state.agentsList?.defaultId;
    const fallback = agents.some((agent) => agent.id === configuredDefault)
      ? (configuredDefault ?? "main")
      : (agents[0]?.id ?? "main");
    const keepSelectedAgent =
      options.preserveSelectedAgent && this.agentSelectedByUser && Boolean(this.selectedAgent());
    if (!keepSelectedAgent) {
      this.agentId = catalog.resolveAgentId(this.data, agents, fallback);
      this.agentSelectedByUser = false;
    }
    const preference = this.preference();
    const keepSelectedFolder = options.preserveSelectedFolder && this.folderSelectedByUser;
    // A node cwd belongs to node discovery, and a locked cloud-recovery draft
    // shows its staged repo; neither may be replaced by a workspace refresh.
    if (!this.execNode && !keepSelectedFolder && !this.pendingCloud.sessionKey) {
      const workspace = this.workspacePath();
      const storedFolder = preference?.folder ?? "";
      // An old agent workspace path is not a custom folder. If the configured
      // workspace moved, use the current value instead of reviving the stale path.
      const storedWorkspaceMoved =
        Boolean(storedFolder) &&
        storedFolder === preference?.workspace &&
        preference.workspace !== workspace;
      // Only an admin can browse outside the workspace, so any other stored
      // folder is unreachable for this viewer.
      const storedFolderUsable =
        Boolean(storedFolder) &&
        !storedWorkspaceMoved &&
        (storedFolder === workspace || this.isAdmin());
      this.folder = storedFolderUsable ? storedFolder : workspace;
      this.folderSelectedByUser = false;
      this.preferredWorktreeRestore = preference?.worktree === true;
      this.worktreeSelectedByUser = false;
      if (storedWorkspaceMoved) {
        this.persistPreference({ folder: workspace });
      }
    }
    if (keepSelectedFolder && !this.execNode && !this.pendingCloud.sessionKey && this.agentId) {
      // A folder picked before agents.list resolves has no stable preference
      // owner. Persist it only after the final agent id is known.
      this.persistPreference({ folder: this.folder, worktree: this.worktree });
    }
    void this.loadNodes();
    this.modelControl.load(this.context, this.agentId, !catalog.isTarget(this.data), {
      agent: this.selectedAgent(),
      preference,
    });
    if (
      !this.folderSelectedByUser &&
      this.folder !== this.workspacePath() &&
      !this.execNode &&
      !this.pendingCloud.sessionKey
    ) {
      this.validateRestoredFolder(this.folder);
    } else {
      this.cancelRestoredFolderValidation();
      this.maybeLoadBranches();
    }
  }

  private resetDraft() {
    const preservePendingCloud = Boolean(this.pendingCloud.sessionKey);
    this.invalidateSubmission();
    this.submissionOutcomeUnknown = preservePendingCloud;
    this.agentSelectedByUser = false;
    this.folder = "";
    this.folderSelectedByUser = false;
    this.cancelRestoredFolderValidation();
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
    this.worktree = false;
    this.visibility = "normal";
    this.worktreeName = "";
    this.baseRef = "";
    this.repository = { kind: "idle" };
    this.execNode = "";
    this.modelControl.reset();
    this.attachmentDraft.reset({ release: true });
    this.cloudProfileId = "";
    if (preservePendingCloud) {
      if (!this.pendingCloud.restored) {
        this.pendingCloud.retryAllowed = false;
      }
      this.agentId = this.pendingCloud.agentId;
      this.cloudProfileId = this.pendingCloud.profileId;
      this.worktree = true;
      this.visibility = this.pendingCloud.createParams?.incognito === true ? "incognito" : "normal";
      // Show the staged repo (not the agent workspace) while the draft is locked.
      this.folder = this.pendingCloud.createParams?.cwd ?? "";
      this.pendingCloud.restored = false;
      this.message = this.pendingCloud.message;
      this.attachmentDraft.replace(restoreChatApiAttachments(this.pendingCloud.attachments));
    } else {
      this.clearPendingCloudRecovery();
      this.message = "";
    }
    this.error = null;
    this.placePopoverHiding = false;
    this.closeAgentDropdown();
    this.closeBrowser();
    this.adoptAgentDefaults();
    void this.updateComplete.then(() => {
      this.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.focus();
    });
  }

  private invalidateSubmission(outcomeUnknown = false) {
    this.submitRequestToken += 1;
    if (outcomeUnknown && this.submitting) {
      this.submissionOutcomeUnknown = true;
    }
    this.submitting = false;
  }

  private clearPendingCloudRecovery() {
    this.pendingCloud.clear();
    this.submissionOutcomeUnknown = false;
  }

  private clearPendingCloudRecoveryFor(
    gatewayUrl: string,
    recoveryScope: string,
    sessionKey: string,
  ) {
    this.pendingCloud.clearFor(gatewayUrl, recoveryScope, sessionKey);
    if (!this.pendingCloud.sessionKey) {
      this.submissionOutcomeUnknown = false;
    }
  }

  private restorePendingCloudRecovery(gatewayUrl: string, recoveryScope: string) {
    const recovery = this.pendingCloud.restore(gatewayUrl, recoveryScope);
    if (!recovery) {
      return;
    }
    this.agentId = recovery.agentId;
    this.cloudProfileId = recovery.profileId;
    this.worktree = true;
    this.visibility = recovery.createParams?.incognito === true ? "incognito" : "normal";
    // Show the staged repo (not the agent workspace) while the draft is locked.
    this.folder = recovery.createParams?.cwd ?? "";
    this.message = recovery.message;
    this.attachmentDraft.replace(restoreChatApiAttachments(recovery.attachments));
  }

  private async loadNodes() {
    const requestId = ++this.nodesRequestToken;
    this.nodesHydrated = false;
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client || !this.isAdmin()) {
      this.nodes = [];
      this.nodesHydrated = true;
      return;
    }
    try {
      const result = await client.request<{ nodes?: unknown }>("node.list", {});
      if (requestId !== this.nodesRequestToken) {
        return;
      }
      const nodes = readDraftNodes(result?.nodes);
      this.nodes = nodes;
      this.nodesHydrated = true;
      if (this.execNode && !nodes.some((node) => node.nodeId === this.execNode && node.canExec)) {
        // A reconnect can remove a device. Its cwd is not meaningful on the
        // Gateway, so fall back to the selected agent's workspace as one unit.
        this.execNode = "";
        this.folder = this.workspacePath();
        this.folderSelectedByUser = false;
        this.worktree = false;
        this.worktreeName = "";
        this.closeBrowser();
        this.maybeLoadBranches();
      }
    } catch {
      if (requestId === this.nodesRequestToken) {
        this.nodes = [];
        this.nodesHydrated = true;
      }
    }
  }

  private maybeLoadBranches() {
    // Repository capability and branch data belong to one Gateway folder.
    // Reset them together so a previous checkout can never leak into create params.
    const requestId = ++this.branchesRequestToken;
    const restoreWorktree = this.preferredWorktreeRestore && !this.worktreeSelectedByUser;
    const baseRefEditGeneration = this.baseRefEditGeneration;
    this.repository = { kind: "idle" };
    this.baseRef = "";
    if (this.execNode) {
      this.preferredWorktreeRestore = false;
      return;
    }
    const repoRoot = this.folder.trim() || this.workspacePath();
    const agent = this.selectedAgent();
    const usesWorkspace = repoRoot === this.workspacePath();
    if (!repoRoot) {
      this.preferredWorktreeRestore = false;
      return;
    }
    if (usesWorkspace && agent?.workspaceGit !== true) {
      this.repository = { kind: "direct", repoRoot };
      const rejectedWorktree = !this.cloudProfileId && (this.worktree || restoreWorktree);
      if (!this.cloudProfileId) {
        this.worktree = false;
      }
      this.preferredWorktreeRestore = false;
      if (rejectedWorktree) {
        this.persistPreference({ worktree: false });
      }
      return;
    }
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client) {
      this.preferredWorktreeRestore = false;
      return;
    }
    this.repository = { kind: "checking", repoRoot };
    void client
      .request<WorktreesBranchesResult>("worktrees.branches", {
        repoRoot,
        includeRepositoryStatus: true,
      })
      .then((result) => {
        if (requestId !== this.branchesRequestToken) {
          return;
        }
        if (result?.repositoryStatus !== "git") {
          this.repository = {
            kind: result?.repositoryStatus === "not_git" ? "direct" : "unavailable",
            repoRoot,
          };
          if (result?.repositoryStatus === "not_git") {
            const rejectedWorktree = !this.cloudProfileId && (this.worktree || restoreWorktree);
            if (!this.cloudProfileId) {
              this.worktree = false;
            }
            if (rejectedWorktree) {
              this.persistPreference({ worktree: false });
            }
          } else if (restoreWorktree && !this.worktreeSelectedByUser && this.worktreeAvailable()) {
            // An inconclusive lookup cannot disprove a stored worktree choice, but
            // it may only be restored while the toggle stays usable: an unavailable
            // repository disables that control, and a box the user cannot clear
            // would strand the draft behind a permanently disabled submit.
            this.worktree = true;
          }
          this.preferredWorktreeRestore = false;
          return;
        }
        this.repository = {
          kind: "git",
          repoRoot,
          branches: result.branches,
          ...(result.defaultBranch ? { defaultBranch: result.defaultBranch } : {}),
          ...(result.headBranch ? { headBranch: result.headBranch } : {}),
        };
        if (restoreWorktree && !this.worktreeSelectedByUser && !this.execNode) {
          this.worktree = true;
        }
        this.preferredWorktreeRestore = false;
        // Discovery supplies a default only while the field is untouched;
        // a user edit made during the request remains authoritative.
        if (baseRefEditGeneration === this.baseRefEditGeneration) {
          this.baseRef = result.defaultBranch ?? result.headBranch ?? "";
        }
      })
      .catch(() => {
        if (requestId !== this.branchesRequestToken) {
          return;
        }
        this.repository = { kind: "unavailable", repoRoot };
        if (restoreWorktree && !this.worktreeSelectedByUser && this.worktreeAvailable()) {
          this.worktree = true;
        }
        this.preferredWorktreeRestore = false;
      });
  }

  private worktreeAvailable(): boolean {
    if (this.execNode) {
      return false;
    }
    if (this.repository.kind === "git") {
      return true;
    }
    return (
      this.repository.kind === "unavailable" &&
      this.repository.repoRoot === this.workspacePath() &&
      this.selectedAgent()?.workspaceGit === true
    );
  }

  private cloudProfileForSubmission(): string {
    return this.pendingCloud.sessionKey ? this.pendingCloud.profileId : this.cloudProfileId;
  }

  private cloudRuntimeUnsupportedReason(): string | undefined {
    const runtime = this.modelControl.resolveAgentRuntimeId({
      agent: this.selectedAgent(),
      context: this.context,
    });
    return runtime && runtime !== "openclaw"
      ? t("newSession.cloudRequiresOpenClawRuntime", { runtime })
      : undefined;
  }

  private cloudDisabledReason(): string | undefined {
    const runtimeReason = this.cloudRuntimeUnsupportedReason();
    if (runtimeReason) {
      return runtimeReason;
    }
    if (this.repository.kind === "checking") {
      return t("newSession.checkingGit");
    }
    if (this.repository.kind === "unavailable" && !this.worktreeAvailable()) {
      return t("newSession.gitCheckUnavailable");
    }
    return this.worktreeAvailable() ? undefined : t("newSession.cloudRequiresWorktree");
  }

  private canSubmit(): boolean {
    const pendingCloud = Boolean(this.pendingCloud.sessionKey);
    const cloudProfileId = this.cloudProfileForSubmission();
    const message = pendingCloud ? this.pendingCloud.message : this.message.trim();
    const hasAttachments = pendingCloud
      ? Boolean(this.pendingCloud.attachments?.length)
      : this.attachmentDraft.attachments.length > 0;
    const gateway = this.context?.gateway;
    if (
      this.submitting ||
      this.requiresModelSetup() ||
      this.attachmentDraft.pendingReads > 0 ||
      (!pendingCloud && this.submissionOutcomeUnknown) ||
      (!message && !hasAttachments) ||
      gateway?.snapshot.phase !== "connected" ||
      !gateway.snapshot.client
    ) {
      return false;
    }
    if (!this.submissionAccess().allowed) {
      return false;
    }
    if (this.restoredFolderValidation !== "none") {
      return false;
    }
    // Stored model and worktree choices are provisional until their current
    // Gateway metadata confirms they still exist. Do not let a fast submit
    // silently replace either preference with the server default.
    if (this.modelControl.isRestoringPreference() || this.preferredWorktreeRestore) {
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
        this.isAdmin(),
      );
    }
    // Pre-hydration the selection is a provisional fallback; submitting then
    // would create the session under the wrong agent.
    if (this.agents().length === 0) {
      return false;
    }
    if (!catalog.allowsSelectedAgent(this.data, this.selectedAgent())) {
      return false;
    }
    if (
      this.execNode &&
      (!this.nodesHydrated || !this.execNodes().some((node) => node.nodeId === this.execNode))
    ) {
      return false;
    }
    if (
      cloudProfileId &&
      (!this.isAdmin() ||
        !gateway.snapshot.client.recoveryScope ||
        !gateway.snapshot.client.recoveryScopeReady ||
        !this.cloudProfilesReady ||
        this.cloudProfileTask.status === TaskStatus.PENDING ||
        !this.worktree ||
        !this.cloudProfiles.some((profile) => profile.id === cloudProfileId) ||
        Boolean(this.cloudRuntimeUnsupportedReason()))
    ) {
      return false;
    }
    if (this.usesCustomFolder() && !this.isAdmin()) {
      return false;
    }
    if (this.execNode && this.worktree) {
      return false;
    }
    if (this.worktree && !this.worktreeAvailable()) {
      return false;
    }
    if (this.worktree && !isWorktreeNameValid(this.worktreeName)) {
      return false;
    }
    return true;
  }

  private requiresModelSetup(): boolean {
    const selectedAgent = this.selectedAgent();
    return requiresChatModelSetup({
      catalog:
        catalog.isTarget(this.data) ||
        Boolean(this.cloudProfileId) ||
        Boolean(this.pendingCloud.sessionKey),
      connected: this.gatewayConnected,
      agentsLoaded: this.context?.agents.state.agentsList !== null,
      selectedAgentFound: selectedAgent !== undefined,
      agentModel: selectedAgent?.model?.primary,
    });
  }

  private async submit() {
    const context = this.context;
    if (!context || !this.canSubmit()) {
      return;
    }
    const pendingCloud = Boolean(this.pendingCloud.sessionKey);
    const message = pendingCloud ? this.pendingCloud.message : this.message.trim();
    const attachments = this.attachmentDraft.attachments;
    const apiAttachments = pendingCloud
      ? this.pendingCloud.attachments
      : buildChatApiAttachments(attachments);
    const submissionAgentId = pendingCloud
      ? this.pendingCloud.agentId
      : normalizeAgentId(this.agentId);
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
    this.submitting = true;
    this.error = null;
    // Retire hidden pickers before their late requests can mutate this submitted draft.
    this.closeBrowser();
    for (const dropdown of this.querySelectorAll<HTMLElement & { open: boolean }>(
      "wa-dropdown[open]",
    )) {
      dropdown.open = false;
    }
    try {
      const cloudProfileId = this.cloudProfileForSubmission();
      // Draft mode can go stale if sharing policy changed since it was selected.
      const draftRetired = this.visibility === "draft" && !this.canStartAsDraft();
      const createParams = buildDraftSessionCreateParams({
        agentId: this.agentId,
        message: cloudProfileId ? "" : message,
        model: this.modelControl.selected,
        thinkingLevel: this.modelControl.thinkingLevel,
        visibility: draftRetired ? "normal" : this.visibility,
        attachments: cloudProfileId ? undefined : apiAttachments,
        worktree: this.worktree,
        baseRef: this.baseRef,
        worktreeName: this.worktreeName,
        cwd: this.folder,
        workspace: this.workspacePath(),
        execNode: this.execNode,
        catalogId: this.data?.catalogId,
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
              persistent: this.visibility !== "incognito",
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
      let recoveryOwnerKey = submissionCloudRecovery?.sessionKey ?? "";
      const ownsSubmissionRecovery = () =>
        this.pendingCloud.owns(submissionGatewayUrl, submissionRecoveryScope, recoveryOwnerKey);
      const isSubmissionCurrent = () =>
        this.isConnected &&
        submissionClient.recoveryScopeReady &&
        requestId === this.submitRequestToken &&
        this.gatewayClient === submissionClient &&
        this.gatewayUrl === submissionGatewayUrl &&
        this.gatewayRecoveryScope === submissionRecoveryScope &&
        ownsSubmissionRecovery();
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
        const recoveryPhase =
          submissionCloudRecovery.phase === "creating"
            ? "dispatching"
            : submissionCloudRecovery.phase;
        if (submissionCloudRecovery.phase === "creating" && isSubmissionCurrent()) {
          if (!this.pendingCloud.promoteToDispatching(result.key)) {
            this.error = t("newSession.cloudStartFailed", {
              error: "cloud recovery storage is unavailable",
            });
            return;
          }
          recoveryOwnerKey = result.key;
        }
        const cloudStart = await advanceCloudDraftSession({
          client: submissionClient,
          key: result.key,
          agentId: submissionAgentId,
          profileId: cloudProfileId,
          message: submissionCloudRecovery.message,
          attachments: submissionCloudRecovery.attachments,
          messageId: submissionCloudRecovery.messageId,
          gatewayUrl: submissionGatewayUrl,
          recoveryScope: submissionRecoveryScope,
          recoveryPhase,
          persistRecovery: this.pendingCloud.persistent,
          recovering: pendingCloud,
          isCurrent: isSubmissionCurrent,
          ownsRecovery: ownsSubmissionRecovery,
          clearRecovery: () =>
            this.clearPendingCloudRecoveryFor(
              submissionGatewayUrl,
              submissionRecoveryScope,
              result.key,
            ),
          setRecoveryPhase: (phase) => {
            if (ownsSubmissionRecovery()) {
              this.pendingCloud.phase = phase;
            }
          },
        });
        if (cloudStart.status === "cancelled") {
          if (!ownsSubmissionRecovery()) {
            return;
          }
          if (cloudStart.cleanupError) {
            this.pendingCloud.retryAllowed = cloudStart.recoveryPersisted;
            this.submissionOutcomeUnknown = !cloudStart.recoveryPersisted;
            this.error = t("newSession.cloudStartFailed", { error: cloudStart.cleanupError });
          } else if (!cloudStart.recoveryPersisted) {
            this.error = t("newSession.createFailed");
          }
          return;
        }
        if (cloudStart.status === "cleanup-rejected") {
          if (!this.pendingCloud.owns(submissionGatewayUrl, submissionRecoveryScope, result.key)) {
            return;
          }
          // Retain durable identity; clearing it could hide a failed teardown's billable worker.
          this.pendingCloud.sessionKey = result.key;
          if (cloudStart.messageId) {
            this.pendingCloud.messageId = cloudStart.messageId;
          }
          const retryAllowed = requestId === this.submitRequestToken;
          this.pendingCloud.retryAllowed = retryAllowed;
          this.submissionOutcomeUnknown = !retryAllowed;
          this.message = this.pendingCloud.message;
          this.error = t("newSession.cloudStartFailed", { error: cloudStart.error });
          return;
        }
        if (cloudStart.status === "dispatch-rejected") {
          this.error = t("newSession.cloudStartFailed", {
            error: cloudStart.error || t("newSession.createFailed"),
          });
          return;
        }
        if (cloudStart.status === "ownership-lost") {
          return;
        }
        if (cloudStart.status === "send-rejected") {
          if (!this.pendingCloud.owns(submissionGatewayUrl, submissionRecoveryScope, result.key)) {
            return;
          }
          this.pendingCloud.messageId = cloudStart.messageId;
          this.pendingCloud.retryAllowed = true;
          this.error = cloudStart.error || t("newSession.createFailed");
          return;
        }
        if (requestId !== this.submitRequestToken) {
          return;
        }
        prepareInitialUserMessageHandoff(
          context.initialUserMessage,
          result.key,
          {
            text: submissionCloudRecovery.message,
            attachments,
            createdAt: submittedAt,
          },
          submissionClient,
          { messageId: cloudStart.messageId, messageSeq: cloudStart.messageSeq },
        );
        this.attachmentDraft.clearAfterSubmit(true);
      } else {
        if (requestId !== this.submitRequestToken) {
          return;
        }
        const handedOffAttachments =
          result.initialRun.status === "rejected" &&
          retainRejectedInitialTurn({
            agentId: this.agentId,
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
            {
              text: message,
              attachments,
              createdAt: submittedAt,
            },
            submissionClient,
            {
              messageId: result.initialRun.messageId,
              messageSeq: result.initialRun.messageSeq,
            },
          );
        }
        this.attachmentDraft.clearAfterSubmit(!handedOffAttachments);
      }
      if (requestId !== this.submitRequestToken) {
        return;
      }
      selectApplicationSession({
        selection: context.agentSelection,
        gateway: context.gateway,
        sessionKey: result.key,
        agentId: submissionAgentId,
      });
      context.navigate(
        "chat",
        sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: result.key,
          agentId: this.agentId,
        }).options,
      );
    } finally {
      if (requestId === this.submitRequestToken) {
        this.submitting = false;
      }
    }
  }

  private selectAgentId(agentId: string) {
    if (this.submitting || this.pendingCloud.sessionKey || catalog.isTarget(this.data)) {
      return;
    }
    // Re-picking the checked agent must not reset the draft (the native
    // select never fired change for the same option).
    if (normalizeAgentId(agentId) === normalizeAgentId(this.agentId)) {
      return;
    }
    this.agentId = normalizeAgentId(agentId);
    this.cancelRestoredFolderValidation();
    this.modelControl.reset();
    this.error = null;
    this.agentSelectedByUser = true;
    this.folderSelectedByUser = false;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
    this.cloudProfileId = "";
    this.worktree = false;
    this.worktreeName = "";
    this.closeBrowser();
    if (this.execNode) {
      // Node cwd choices are agent-scoped draft state; switching agents must
      // not carry the previous agent's remote path into the next session.
      this.folder = "";
    }
    this.adoptAgentDefaults({ preserveSelectedAgent: true });
  }

  /**
   * Loaded branch data already covers the effective Gateway repo selection.
   * Branch data is always Gateway-owned: maybeLoadBranches clears and never
   * requests while a node is selected, so a path match cannot cross hosts.
   */
  private branchesMatchCurrentRepo(): boolean {
    if (this.execNode || this.repository.kind === "idle") {
      return false;
    }
    const repoRoot = this.folder.trim() || this.workspacePath();
    return this.repository.repoRoot === repoRoot;
  }

  private applyFolder(folder: string, execNode = this.execNode) {
    if (this.submitting || this.pendingCloud.sessionKey) {
      return;
    }
    this.execNode = execNode;
    this.cancelRestoredFolderValidation();
    if (execNode) {
      // Node sessions run on that device; a cloud worker cannot sync a node path.
      this.cloudProfileId = "";
    }
    this.error = null;
    this.folder = folder.trim();
    this.folderSelectedByUser = true;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    if (this.execNode) {
      this.worktree = false;
    } else if (!this.cloudProfileId) {
      // A newly selected Gateway folder starts direct. Git capability discovery
      // may reveal the optional managed-worktree control afterward.
      this.worktree = false;
    }
    this.worktreeName = "";
    if (!this.execNode && this.agentsHydrated) {
      this.persistPreference({ folder: this.folder, worktree: this.worktree });
    }
    this.maybeLoadBranches();
  }

  private selectExecNode(execNode: string) {
    if (this.submitting || this.pendingCloud.sessionKey) {
      return;
    }
    if (execNode === this.execNode && !this.cloudProfileId) {
      return;
    }
    // Turning a cloud selection back into a plain Gateway session keeps the
    // picked repo; only a host change retires the folder path.
    const keepGatewayFolder = !execNode && !this.execNode;
    this.cancelRestoredFolderValidation();
    const keepWorktree = keepGatewayFolder && this.worktree && this.worktreeAvailable();
    this.execNode = execNode;
    this.cloudProfileId = "";
    if (!keepGatewayFolder) {
      // Folder paths belong to one host; never carry a Gateway or node path to another host.
      this.folder = execNode ? "" : this.workspacePath();
      this.folderSelectedByUser = false;
    }
    this.worktree = keepWorktree;
    this.closeBrowser();
    if (!this.branchesMatchCurrentRepo()) {
      this.maybeLoadBranches();
    }
  }

  private selectCloudProfile(profileId: string) {
    if (
      this.submitting ||
      this.pendingCloud.sessionKey ||
      !this.worktreeAvailable() ||
      !this.cloudProfiles.some((profile) => profile.id === profileId)
    ) {
      return;
    }
    // worktreeAvailable() is false for node targets, so this transition always
    // starts from a Gateway selection and the folder is a Gateway path. It
    // stays selected: its repo is what the managed worktree checks out and the
    // dispatch tunnel syncs to the cloud worker.
    this.cloudProfileId = profileId;
    this.error = null;
    this.worktree = true;
    this.closeBrowser();
    if (!this.branchesMatchCurrentRepo()) {
      this.maybeLoadBranches();
    }
  }

  private browseAvailable(): boolean {
    return this.isAdmin();
  }

  private closeAgentDropdown() {
    const dropdown = this.querySelector<HTMLElement & { open: boolean }>(
      ".new-session-page__select--agent wa-dropdown",
    );
    if (dropdown) {
      dropdown.open = false;
    }
  }

  private closeBrowser() {
    this.browserRequestToken += 1;
    this.browserLoading = false;
    this.browserError = null;
    this.browserListing = null;
    this.browserTarget = null;
    this.browserPathDraft = "";
    this.placePopoverOpen = false;
    const popover = this.querySelector<HTMLElement & { open: boolean }>(
      ".new-session-page__place-popover",
    );
    if (popover) {
      popover.open = false;
    }
  }

  private guardPopoverTransition(event: Event, hiding: boolean) {
    if (!hiding) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private restorePopoverTrigger(id: string, popoverSelector: string) {
    const active = this.ownerDocument.activeElement;
    const popover = this.querySelector(popoverSelector);
    // Light-dismissal may already have moved focus to another control. Only
    // recover when focus stayed in the closing popover or fell back to body.
    if (active && active !== this.ownerDocument.body && !popover?.contains(active)) {
      return;
    }
    this.querySelector<HTMLButtonElement>(`#${id}`)?.focus();
  }

  private showBrowserRoot() {
    this.browserRequestToken += 1;
    this.browserLoading = false;
    this.browserError = null;
    this.browserListing = null;
    this.browserTarget = null;
    this.browserPathDraft = "";
  }

  /** Use applies the live path; empty means host default, null disables. */
  private usableBrowserPath(): string | null {
    const draft = this.browserPathDraft.trim();
    if (draft.length === 0) {
      return "";
    }
    return isAbsolutePath(draft) ? draft : null;
  }

  private selectBrowserTarget(target: BrowserTarget) {
    const folder = this.folder.trim();
    const matchesCurrentTarget = target.nodeId === this.execNode;
    const path = matchesCurrentTarget && isAbsolutePath(folder) ? folder : undefined;
    this.browserTarget = target;
    this.loadBrowser(path);
  }

  private loadBrowser(path: string | undefined) {
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.client;
    const target = this.browserTarget;
    if (snapshot?.phase !== "connected" || !client || !target) {
      return;
    }
    // Exec-only nodes still accept a typed cwd; never probe an unsupported fs.listDir.
    const targetNode = this.nodes.find((node) => node.nodeId === target.nodeId);
    if (targetNode?.canExec && !targetNode.canBrowse) {
      this.showBrowserRoot();
      this.browserTarget = target;
      this.browserPathDraft = path ?? "";
      return;
    }
    const requestId = ++this.browserRequestToken;
    this.browserLoading = true;
    this.browserError = null;
    // Clear the previous directory immediately: keeping it clickable while the
    // request is in flight would let "Use this folder" apply the stale path.
    this.browserListing = null;
    // Navigation owns the shown path at once, so a mid-flight "Use this
    // folder" applies where the user is heading, never the directory they
    // just left ("" = the host default while heading home).
    this.browserPathDraft = path ?? "";
    const draftAtRequest = this.browserPathDraft;
    void client
      .request<FsListDirResult>("fs.listDir", {
        ...(path ? { path } : {}),
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
      })
      .then((result) => {
        if (requestId !== this.browserRequestToken) {
          return;
        }
        this.browserListing = result ?? null;
        // Sync the head input to the listed directory unless the user typed
        // while this request was in flight; their edit wins.
        if (result?.path && this.browserPathDraft === draftAtRequest) {
          this.browserPathDraft = result.path;
        }
      })
      .catch(() => {
        if (requestId !== this.browserRequestToken) {
          return;
        }
        // A stale or mistyped folder should not strand the picker: fall back home.
        if (path) {
          this.loadBrowser(undefined);
          return;
        }
        this.browserError = t("newSession.browserLoadFailed");
      })
      .finally(() => {
        if (requestId === this.browserRequestToken) {
          this.browserLoading = false;
        }
      });
  }

  private renderAgentSelect(agents: ReturnType<NewSessionPage["agents"]>) {
    return renderAgentSelect({
      agents,
      agentId: this.agentId,
      disabled: this.submitting || Boolean(this.pendingCloud.sessionKey),
      onSelect: (agentId) => this.selectAgentId(agentId),
    });
  }

  private renderPlaceSelect() {
    const execNodes = this.execNodes();
    const cloudProfiles = catalog.isTarget(this.data) ? [] : this.cloudProfiles;
    const branches = this.repository.kind === "git" ? this.repository : null;
    const cloudDisabledReason = this.cloudDisabledReason();
    return renderPlaceSelect({
      browseAvailable: this.browseAvailable(),
      folder: this.folder,
      workspace: this.workspacePath(),
      sessions: this.context?.sessions.state.result?.sessions ?? [],
      execNodes: this.isAdmin() ? execNodes : [],
      gatewayName: this.gatewayName,
      cloudProfiles: this.isAdmin() ? cloudProfiles : [],
      cloudProfileId: this.cloudProfileId,
      execNode: this.execNode,
      syncFolder: this.folder.trim() || this.workspacePath(),
      worktree: this.worktree,
      worktreeVisible: this.worktreeAvailable() || Boolean(this.cloudProfileId) || this.worktree,
      worktreeAvailable: this.worktreeAvailable(),
      worktreeDisabledReason:
        this.repository.kind === "checking"
          ? t("newSession.checkingGit")
          : this.repository.kind === "unavailable"
            ? t("newSession.gitCheckUnavailable")
            : undefined,
      cloudDisabledReason,
      branches,
      branchesLoading: this.repository.kind === "checking",
      baseRef: this.baseRef,
      worktreeName: this.worktreeName,
      submitting: this.submitting,
      pendingCloud: Boolean(this.pendingCloud.sessionKey),
      // Admin gates only the discovered choices. An existing node or cloud
      // selection always keeps the destination axis visible — hiding it (e.g.
      // after a failed node.list or an auth downgrade) would misreport a
      // remote-targeted draft as Gateway-local.
      showDestinations:
        Boolean(this.execNode) ||
        Boolean(this.cloudProfileId) ||
        (this.isAdmin() && (execNodes.length > 0 || cloudProfiles.length > 0)),
      popoverOpen: this.placePopoverOpen,
      popoverHiding: this.placePopoverHiding,
      browserTarget: this.browserTarget,
      browserListing: this.browserListing,
      browserLoading: this.browserLoading,
      browserError: this.browserError,
      browserPathDraft: this.browserPathDraft,
      usableBrowserPath: this.usableBrowserPath(),
      onGuardTransition: (event) => this.guardPopoverTransition(event, this.placePopoverHiding),
      onPopoverShow: () => {
        this.placePopoverOpen = true;
        this.showBrowserRoot();
      },
      onPopoverHide: () => {
        this.placePopoverOpen = false;
        this.placePopoverHiding = true;
        this.showBrowserRoot();
      },
      onPopoverAfterHide: () => {
        this.placePopoverHiding = false;
        this.restorePopoverTrigger("new-session-place-trigger", ".new-session-page__place-popover");
      },
      onSelectExecNode: (nodeId) => this.selectExecNode(nodeId),
      onSelectCloudProfile: (profileId) => this.selectCloudProfile(profileId),
      onApplyFolder: (folder, execNode) => this.applyFolder(folder, execNode),
      onBrowse: (target) => this.selectBrowserTarget(target),
      onBrowserPathDraftChange: (value) => {
        this.browserPathDraft = value;
      },
      onBrowserNavigate: (path) => this.loadBrowser(path),
      onBrowserBack: () => this.showBrowserRoot(),
      onClose: () => this.closeBrowser(),
      onToggleWorktree: () => {
        if (this.cloudProfileId) {
          return;
        }
        this.worktree = !this.worktree;
        this.preferredWorktreeRestore = false;
        this.worktreeSelectedByUser = true;
        this.persistPreference({
          folder: this.folder.trim() || this.workspacePath(),
          worktree: this.worktree,
        });
        if (this.worktree) {
          this.maybeLoadBranches();
        }
      },
      onBaseRefInput: (baseRef) => {
        if (!this.submitting) {
          this.baseRefEditGeneration += 1;
          this.baseRef = baseRef;
        }
      },
      onWorktreeNameInput: (worktreeName) => {
        if (!this.submitting) {
          this.worktreeName = worktreeName;
        }
      },
    });
  }

  private renderTargetBar() {
    const agents = this.agents();
    return catalog.renderBar({
      data: this.data,
      agentSelect: agents.length > 1 ? this.renderAgentSelect(agents) : nothing,
      placeSelect: this.renderPlaceSelect(),
      retrying: this.catalogRetrying,
      onRetry: this.handleCatalogRetry,
    });
  }

  /** Target row + composer, rendered mid-screen between the hero and recents. */
  private renderDraftBlock() {
    const worktreeNameInvalid = this.worktree && !isWorktreeNameValid(this.worktreeName);
    return html`
      <div class="new-session-page__draft" aria-busy=${String(this.submitting)}>
        ${this.renderTargetBar()}
        ${worktreeNameInvalid ? renderDraftError(t("newSession.worktreeNameInvalid")) : nothing}
        ${this.error ? renderDraftError(this.error) : nothing}
        ${this.submissionOutcomeUnknown
          ? renderDraftError(t("newSession.createOutcomeUnknown"))
          : nothing}
        ${renderNewSessionDraftComposer({
          agent: this.selectedAgent(),
          agentId: this.agentId,
          attachmentDraft: this.attachmentDraft,
          canSubmit: this.canSubmit(),
          submitDisabledReason: this.submitDisabledReason(),
          context: this.context,
          isCatalogTarget: catalog.isTarget(this.data),
          message: this.message,
          visibility: this.visibility,
          draftAvailable: this.canStartAsDraft(),
          modelControl: this.modelControl,
          requiresModifier: loadSettings().chatSendShortcut === "modifier-enter",
          submitting: this.submitting,
          textareaController: this.composerTextarea,
          messageLocked: Boolean(this.pendingCloud.sessionKey),
          incognitoDisabledReason: this.incognitoDisabledReason(),
          onInput: (message) => {
            if (!this.submitting && !this.pendingCloud.sessionKey) {
              this.message = message;
            }
          },
          onVisibilityChange: (visibility) => {
            if (!this.submitting && !this.pendingCloud.sessionKey) {
              this.visibility = visibility;
            }
          },
          onSubmit: () => void this.submit(),
        })}
      </div>
    `;
  }

  /** Same welcome block as the empty-chat start screen, keyed to the draft's agent. */
  private renderWelcome() {
    const agent = this.selectedAgent();
    const identity = agent?.identity;
    const gateway = this.context?.gateway.snapshot;
    return renderWelcomeState({
      assistantName: identity?.name ?? agent?.name ?? agent?.id ?? "",
      assistantAvatar: identity?.avatar ?? identity?.emoji ?? null,
      assistantAvatarUrl: identity?.avatarUrl ?? null,
      hint: t("newSession.hint"),
      composer: this.renderDraftBlock(),
      modelSetupRequired: this.requiresModelSetup(),
      onModelSetup: () => this.context?.navigate("model-setup"),
      sessions: this.context?.sessions.state.result,
      sessionKey: buildAgentMainSessionKey({
        agentId: this.agentId || "main",
        mainKey: this.context?.agents.state.agentsList?.mainKey,
      }),
      sessionHost: {
        assistantAgentId: gateway?.assistantAgentId ?? null,
        agentsList: this.context?.agents.state.agentsList ?? null,
        hello: gateway?.hello ?? null,
      },
      onDraftChange: (next) => {
        if (!this.submitting && !this.pendingCloud.sessionKey) {
          this.message = next;
        }
      },
      onSend: () => void this.submit(),
      onOpenSession: (sessionKey) => {
        if (this.submitting || this.pendingCloud.sessionKey) {
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
          agentId: this.agentId,
        });
        context.navigate(
          "chat",
          sessionNavigationTarget({
            context,
            face: "chat",
            sessionKey,
          }).options,
        );
      },
    });
  }

  override render() {
    return html`
      <div class="new-session-page">
        <div
          class="new-session-page__scroll"
          ?inert=${this.submitting}
          aria-busy=${String(this.submitting)}
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

export type { NewSessionPage };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
