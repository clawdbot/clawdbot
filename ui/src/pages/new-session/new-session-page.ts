import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  FsListDirResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { loadSettings } from "../../app/settings.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat.css";
import "../../styles/new-session.css";
import { buildChatApiAttachments, restoreChatApiAttachments } from "../chat/attachment-api.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import { prepareInitialUserMessageHandoff } from "../chat/initial-turn-handoff.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import * as catalog from "./catalog-target.ts";
import { CloudProfileDiscovery, selectProfiles } from "./cloud-profile-discovery.ts";
import { PendingCloudRecoveryState, resolveScope } from "./cloud-recovery-state.ts";
import { advanceCloudDraftSession } from "./cloud-submit.ts";
import { renderDraftError, renderNewSessionDraftComposer } from "./composer.ts";
import {
  buildDraftSessionCreateParams,
  canStartSessionAsDraft,
  isWorktreeNameValid,
} from "./create-params.ts";
import {
  type BrowserTarget,
  type DraftCloudProfile,
  type DraftNode,
  type DraftRepositoryState,
  readDraftNodes,
} from "./discovery.ts";
import { GatewayNameDiscovery } from "./gateway-name-discovery.ts";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { isAbsolutePath } from "./path.ts";
import { renderPlaceSelect } from "./place-picker.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import { renderAgentSelect, renderStartAsDraftToggle } from "./target-controls.ts";

const CATALOG_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

class NewSessionPage extends OpenClawLightDomElement {
  @property({ attribute: false }) data: NewSessionRouteData | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private agentId = "";
  @state() private folder = "";
  @state() private worktree = false;
  @state() private incognito = false;
  @state() private worktreeName = "";
  @state() private startAsDraft = false;
  @state() private baseRef = "";
  @state() private repository: DraftRepositoryState = { kind: "idle" };
  @state() private nodes: DraftNode[] = [];
  @state() private gatewayName = "";
  @state() private execNode = "";
  @state() private cloudProfiles: DraftCloudProfile[] = [];
  @state() private cloudProfilesHydrated = false;
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

  private openedFor: string | null = null;
  private agentsHydrated = false;
  private nodesHydrated = false;
  // Discovery retry provenance separates user choices from Gateway-derived defaults.
  private agentSelectedByUser = false;
  private folderSelectedByUser = false;
  private submitRequestToken = 0;
  private nodesRequestToken = 0;
  private readonly gatewayNameDiscovery = new GatewayNameDiscovery(
    () => this.context?.gateway.snapshot,
    (name) => (this.gatewayName = name),
  );
  private readonly pendingCloud = new PendingCloudRecoveryState();
  private readonly cloudProfileDiscovery = new CloudProfileDiscovery({
    snapshot: () => ({
      connected: this.gatewayConnected,
      client: this.gatewayClient,
      admin: this.isAdmin(),
      pendingCloud: Boolean(this.pendingCloud.sessionKey),
      selectedId: this.cloudProfileId,
    }),
    update: ({ profiles, hydrated, clearSelection, selectionUnavailable }) => {
      const recovery = selectProfiles(profiles, this.gatewayClient, this.gatewayRecoveryScope);
      this.cloudProfiles = recovery.profiles;
      this.cloudProfilesHydrated = hydrated;
      if (clearSelection) {
        this.cloudProfileId = "";
        this.closeBrowser();
      }
      if (selectionUnavailable) {
        this.error = t("newSession.catalogUnavailable");
      } else if (recovery.unsupported) {
        this.error = t("newSession.cloudSecureContextRequired");
      } else if (this.error === t("newSession.cloudSecureContextRequired")) {
        this.error = null;
      }
    },
  });
  private branchesRequestToken = 0;
  private baseRefEditGeneration = 0;
  private browserRequestToken = 0;
  private readonly attachmentDraft = new NewSessionAttachmentDraft(() => this.requestUpdate());
  private readonly modelControl = new NewSessionModelControl(() => this.requestUpdate());
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
    if (this.startAsDraft && !this.canStartAsDraft()) {
      this.startAsDraft = false;
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
        void this.gatewayNameDiscovery.load();
      }
      void this.cloudProfileDiscovery.load();
    }
  }

  private invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.nodesRequestToken += 1;
    this.nodesHydrated = false;
    this.gatewayNameDiscovery.invalidate();
    this.cloudProfileDiscovery.invalidate();
    this.branchesRequestToken += 1;
    this.repository = { kind: "idle" };
    this.baseRef = ""; // Never carry a derived ref across a transport epoch.
    this.agentsHydrated = false;
    this.modelControl.invalidate(resetHostSelection);
    this.attachmentDraft.abortReads();
    this.closeBrowser();
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
    this.worktree = false;
    this.incognito = false;
    this.worktreeName = "";
    this.startAsDraft = false;
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
    const picker = this.querySelector<HTMLDetailsElement>(".chat-controls__model[open]");
    if (!picker) {
      return;
    }
    if (event.type === "keydown") {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.defaultPrevented || keyEvent.key !== "Escape") {
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
    if (!event.composedPath().includes(picker)) {
      picker.open = false;
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    // /new renders chat controls without ChatPane, so the route owns both
    // pointer and Escape light-dismissal for the combined picker.
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
    this.cloudProfileDiscovery.stop();
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
    if (this.openedFor !== openKey) {
      this.openedFor = openKey;
      this.agentsHydrated = agentsReady;
      this.resetDraft();
      return;
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
    const keepSelectedFolder = options.preserveSelectedFolder && this.folderSelectedByUser;
    // A node cwd belongs to node discovery, and a locked cloud-recovery draft
    // shows its staged repo; neither may be replaced by a workspace refresh.
    if (!this.execNode && !keepSelectedFolder && !this.pendingCloud.sessionKey) {
      this.folder = this.workspacePath();
      this.folderSelectedByUser = false;
    }
    void this.loadNodes();
    this.modelControl.load(this.context, this.agentId, !catalog.isTarget(this.data));
    this.maybeLoadBranches();
  }

  private resetDraft() {
    const preservePendingCloud = Boolean(this.pendingCloud.sessionKey);
    this.invalidateSubmission();
    this.submissionOutcomeUnknown = preservePendingCloud;
    this.agentSelectedByUser = false;
    this.folder = "";
    this.folderSelectedByUser = false;
    this.worktree = false;
    this.incognito = false;
    this.worktreeName = "";
    this.startAsDraft = false;
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
      this.incognito = this.pendingCloud.createParams?.incognito === true;
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
    this.incognito = recovery.createParams?.incognito === true;
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
    const baseRefEditGeneration = this.baseRefEditGeneration;
    this.repository = { kind: "idle" };
    this.baseRef = "";
    if (this.execNode) {
      return;
    }
    const repoRoot = this.folder.trim() || this.workspacePath();
    const agent = this.selectedAgent();
    const usesWorkspace = repoRoot === this.workspacePath();
    if (!repoRoot) {
      return;
    }
    if (usesWorkspace && agent?.workspaceGit !== true) {
      this.repository = { kind: "direct", repoRoot };
      if (!this.cloudProfileId) {
        this.worktree = false;
      }
      return;
    }
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client) {
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
          if (result?.repositoryStatus === "not_git" && !this.cloudProfileId) {
            this.worktree = false;
          }
          return;
        }
        this.repository = {
          kind: "git",
          repoRoot,
          branches: result.branches,
          ...(result.defaultBranch ? { defaultBranch: result.defaultBranch } : {}),
          ...(result.headBranch ? { headBranch: result.headBranch } : {}),
        };
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
      this.attachmentDraft.pendingReads > 0 ||
      (!pendingCloud && this.submissionOutcomeUnknown) ||
      (!message && !hasAttachments) ||
      gateway?.snapshot.phase !== "connected" ||
      !gateway.snapshot.client
    ) {
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
        !this.cloudProfilesHydrated ||
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
    const submissionConnection = context.gateway.snapshot.hello;
    if (!submissionClient || !submissionConnection) {
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
      const createParams = buildDraftSessionCreateParams({
        agentId: this.agentId,
        message: cloudProfileId ? "" : message,
        model: this.modelControl.selected,
        thinkingLevel: this.modelControl.thinkingLevel,
        incognito: this.incognito,
        attachments: cloudProfileId ? undefined : apiAttachments,
        worktree: this.worktree,
        baseRef: this.baseRef,
        worktreeName: this.worktreeName,
        cwd: this.folder,
        workspace: this.workspacePath(),
        execNode: this.execNode,
        catalogId: this.data?.catalogId,
        startAsDraft: this.startAsDraft && this.canStartAsDraft(),
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
              persistent: !this.incognito,
            })
        : undefined;
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
          submissionConnection,
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
            submissionConnection,
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
      context.gateway.setSessionKey(result.key);
      context.navigate("chat", { search: searchForSession(result.key) });
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
    this.modelControl.reset();
    this.error = null;
    this.agentSelectedByUser = true;
    this.folder = this.execNode ? "" : this.workspacePath();
    this.folderSelectedByUser = false;
    this.cloudProfileId = "";
    this.worktree = false;
    this.worktreeName = "";
    this.closeBrowser();
    this.modelControl.load(this.context, this.agentId, true);
    this.maybeLoadBranches();
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
    if (execNode) {
      // Node sessions run on that device; a cloud worker cannot sync a node path.
      this.cloudProfileId = "";
    }
    this.error = null;
    this.folder = folder.trim();
    this.folderSelectedByUser = true;
    if (this.execNode) {
      this.worktree = false;
    } else if (!this.cloudProfileId) {
      // A newly selected Gateway folder starts direct. Git capability discovery
      // may reveal the optional managed-worktree control afterward.
      this.worktree = false;
    }
    this.worktreeName = "";
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
      draftVisibilityControl: this.canStartAsDraft()
        ? renderStartAsDraftToggle({
            checked: this.startAsDraft,
            disabled: this.submitting || Boolean(this.pendingCloud.sessionKey),
            onChange: (checked) => {
              if (!this.submitting && !this.pendingCloud.sessionKey) {
                this.startAsDraft = checked;
              }
            },
          })
        : nothing,
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
          context: this.context,
          isCatalogTarget: catalog.isTarget(this.data),
          message: this.message,
          incognito: this.incognito,
          modelControl: this.modelControl,
          requiresModifier: loadSettings().chatSendShortcut === "modifier-enter",
          submitting: this.submitting,
          messageLocked: Boolean(this.pendingCloud.sessionKey),
          onInput: (message) => {
            if (!this.submitting && !this.pendingCloud.sessionKey) {
              this.message = message;
            }
          },
          onToggleIncognito: () => {
            if (!this.submitting && !this.pendingCloud.sessionKey) {
              this.incognito = !this.incognito;
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
        this.context?.gateway.setSessionKey(sessionKey);
        this.context?.navigate("chat", { search: searchForSession(sessionKey) });
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
