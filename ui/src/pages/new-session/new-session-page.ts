import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { loadSettings } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat.css";
import "../../styles/new-session.css";
import { buildChatApiAttachments, restoreChatApiAttachments } from "../chat/attachment-api.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import * as catalog from "./catalog-target.ts";
import { CloudProfileDiscovery, selectProfiles } from "./cloud-profile-discovery.ts";
import { PendingCloudRecoveryState, resolveScope } from "./cloud-recovery-state.ts";
import { advanceCloudDraftSession } from "./cloud-submit.ts";
import { renderNewSessionDraftComposer } from "./composer.ts";
import { buildDraftSessionCreateParams, isWorktreeNameValid } from "./create-params.ts";
import {
  type BrowserTarget,
  type DraftCloudProfile,
  type DraftBranches,
  type DraftNode,
  readDraftNodes,
} from "./discovery.ts";
import { renderFolderBrowser } from "./folder-browser.ts";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { isAbsolutePath } from "./path.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import { renderAgentSelect, renderFolderSelect, renderWhereSelect } from "./target-controls.ts";

const CATALOG_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

function renderDraftError(message: string) {
  return html`
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span class="callout__content new-session-page__alert-message">${message}</span>
    </div>
  `;
}

class NewSessionPage extends OpenClawLightDomElement {
  @property({ attribute: false }) data: NewSessionRouteData | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private agentId = "";
  @state() private folder = "";
  @state() private worktree = false;
  @state() private worktreeName = "";
  @state() private baseRef = "";
  @state() private branches: DraftBranches | null = null;
  @state() private branchesLoading = false;
  @state() private nodes: DraftNode[] = [];
  @state() private execNode = "";
  @state() private cloudProfiles: DraftCloudProfile[] = [];
  @state() private cloudProfilesHydrated = false;
  @state() private cloudProfileId = "";
  @state() private message = "";
  @state() private submitting = false;
  @state() private submissionOutcomeUnknown = false;
  @state() private error: string | null = null;
  @state() private catalogRetrying = false;
  @state() private browserOpen = false;
  @state() private browserLoading = false;
  @state() private browserError: string | null = null;
  @state() private browserListing: FsListDirResult | null = null;
  @state() private browserTarget: BrowserTarget | null = null;
  @state() private wherePopoverOpen = false;
  @state() private wherePopoverHiding = false;
  @state() private agentPopoverOpen = false;
  @state() private agentPopoverHiding = false;
  @state() private folderPopoverHiding = false;
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
        this.closeWherePopover();
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
    const firstBind = this.gatewaySource === null;
    const gatewayUrlChanged = !firstBind && this.gatewayUrl !== gateway.connection.gatewayUrl;
    const identityChanged =
      !firstBind && (this.gatewaySource !== gateway || this.gatewayClient !== snapshot.client);
    const connectionChanged = !firstBind && this.gatewayConnected !== snapshot.connected;
    const becameConnected = snapshot.connected && (identityChanged || !this.gatewayConnected);
    const recoveryScopeBecameReady =
      snapshot.connected &&
      snapshot.client?.recoveryScopeReady === true &&
      !this.gatewayRecoveryScopeReady;
    const recoveryScope = resolveScope(snapshot, this.gatewayRecoveryScope, firstBind);
    this.gatewaySource = gateway;
    this.gatewayClient = snapshot.client;
    this.gatewayUrl = gateway.connection.gatewayUrl;
    this.gatewayRecoveryScope = recoveryScope.next;
    this.gatewayRecoveryScopeReady = snapshot.client?.recoveryScopeReady === true;
    this.gatewayConnected = snapshot.connected;
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
      if (snapshot.connected && snapshot.client?.recoveryScopeReady) {
        this.restorePendingCloudRecovery(this.gatewayUrl, this.gatewayRecoveryScope);
      }
    }
    if (becameConnected || recoveryScope.changed) {
      if (becameConnected) {
        this.gatewayConnectionEpoch += 1;
        this.retryPendingCatalogTarget();
      }
      void this.cloudProfileDiscovery.load();
    }
  }

  private invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.nodesRequestToken += 1;
    this.nodesHydrated = false;
    this.cloudProfileDiscovery.invalidate();
    this.branchesRequestToken += 1;
    this.branchesLoading = false;
    this.branches = null;
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

  override disconnectedCallback() {
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
    return this.context?.agents.state.agentsList?.agents ?? [];
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
    const fallback = this.context?.agents.state.agentsList?.defaultId ?? agents[0]?.id ?? "main";
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
    this.worktreeName = "";
    this.baseRef = "";
    this.branches = null;
    this.branchesLoading = false;
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
    this.wherePopoverHiding = false;
    this.agentPopoverHiding = false;
    this.folderPopoverHiding = false;
    this.closeWherePopover();
    this.closeAgentPopover();
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
    if (!snapshot?.connected || !client || !this.isAdmin()) {
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
    // Branch data belongs to one repository selection. Clear it before any
    // exit or request so a previous repo's ref can never reach sessions.create.
    const requestId = ++this.branchesRequestToken;
    const baseRefEditGeneration = this.baseRefEditGeneration;
    this.branches = null;
    this.branchesLoading = false;
    this.baseRef = "";
    if (this.execNode) {
      return;
    }
    const repoRoot = this.folder.trim() || this.workspacePath();
    const agent = this.selectedAgent();
    const usesWorkspace = repoRoot === this.workspacePath();
    if (!repoRoot || (usesWorkspace && agent?.workspaceGit !== true)) {
      this.branches = null;
      return;
    }
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.client;
    if (!snapshot?.connected || !client) {
      return;
    }
    this.branchesLoading = true;
    void client
      .request<DraftBranches>("worktrees.branches", { repoRoot })
      .then((result) => {
        if (requestId !== this.branchesRequestToken) {
          return;
        }
        this.branches = result ? { ...result, repoRoot } : null;
        // Discovery supplies a default only while the field is untouched;
        // a user edit made during the request remains authoritative.
        if (baseRefEditGeneration === this.baseRefEditGeneration) {
          this.baseRef = result?.defaultBranch ?? result?.headBranch ?? "";
        }
      })
      .catch(() => {
        if (requestId === this.branchesRequestToken) {
          this.branches = null;
        }
      })
      .finally(() => {
        if (requestId === this.branchesRequestToken) {
          this.branchesLoading = false;
        }
      });
  }

  private worktreeAvailable(): boolean {
    if (this.execNode) {
      return false;
    }
    if (this.usesCustomFolder()) {
      return this.isAdmin();
    }
    return this.selectedAgent()?.workspaceGit === true;
  }

  private cloudProfileForSubmission(): string {
    return this.pendingCloud.sessionKey ? this.pendingCloud.profileId : this.cloudProfileId;
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
      !gateway?.snapshot.connected ||
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
        !this.cloudProfiles.some((profile) => profile.id === cloudProfileId))
    ) {
      return false;
    }
    if (this.usesCustomFolder() && (!this.isAdmin() || (!this.execNode && !this.worktree))) {
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
    if (!submissionClient) {
      return;
    }
    const submissionRecoveryScope = pendingCloud
      ? this.pendingCloud.recoveryScope
      : submissionClient.recoveryScope;
    const requestId = ++this.submitRequestToken;
    this.submitting = true;
    this.error = null;
    // Retire hidden pickers before their late requests can mutate this submitted draft.
    this.closeWherePopover();
    this.closeAgentPopover();
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
          : await context.sessions.createResult(cloudCreateParams ?? createParams);
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
        this.attachmentDraft.clearAfterSubmit(true);
      } else {
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
    if (this.execNode) {
      return false;
    }
    const repoRoot = this.folder.trim() || this.workspacePath();
    return this.branches?.repoRoot === repoRoot;
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
    } else if (this.usesCustomFolder() || this.cloudProfileId) {
      // Explicit host paths and cloud dispatch only materialize through a managed worktree.
      this.worktree = true;
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
    this.execNode = execNode;
    this.cloudProfileId = "";
    if (!keepGatewayFolder) {
      // Folder paths belong to one host; never carry a Gateway or node path to another host.
      this.folder = execNode ? "" : this.workspacePath();
      this.folderSelectedByUser = false;
    }
    this.worktree = keepGatewayFolder && this.usesCustomFolder();
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

  /** Unavailable device rows say why; exec-only nodes remain selectable for manual paths. */
  private nodeBrowseBlockedReason(node: DraftNode): string | undefined {
    if (node.canBrowse) {
      return undefined;
    }
    return node.connected ? t("newSession.nodeCannotBrowse") : t("newSession.nodeOffline");
  }

  private closeBrowser() {
    this.browserRequestToken += 1;
    // Reset state before collapsing the dropdown so its hide handler sees
    // browserOpen === false and does not re-enter this method.
    this.browserOpen = false;
    this.browserLoading = false;
    this.browserError = null;
    this.browserListing = null;
    this.browserTarget = null;
    this.browserPathDraft = "";
    const popover = this.querySelector<HTMLElement & { open: boolean }>(
      ".new-session-page__select--folder",
    );
    if (popover) {
      popover.open = false;
    }
  }

  private closeWherePopover() {
    this.wherePopoverOpen = false;
    const popover = this.querySelector<HTMLElement & { open: boolean }>(
      ".new-session-page__where-popover",
    );
    if (popover) {
      popover.open = false;
    }
  }

  private closeAgentPopover() {
    this.agentPopoverOpen = false;
    const popover = this.querySelector<HTMLElement & { open: boolean }>(
      ".new-session-page__agent-popover",
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
    if (!snapshot?.connected || !client || !target) {
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

  private renderBrowser() {
    return renderFolderBrowser({
      open: this.browserOpen,
      listing: this.browserListing,
      target: this.browserTarget,
      nodes: this.nodes,
      loading: this.browserLoading,
      error: this.browserError,
      pathDraft: this.browserPathDraft,
      usablePath: this.usableBrowserPath(),
      onPathDraftChange: (value) => {
        this.browserPathDraft = value;
      },
      onNavigate: (path) => this.loadBrowser(path),
      onShowRoot: () => this.showBrowserRoot(),
      onClose: () => this.closeBrowser(),
      onSelectTarget: (target) => this.selectBrowserTarget(target),
      nodeBlockedReason: (node) => this.nodeBrowseBlockedReason(node),
      onApplyFolder: (path, nodeId) => this.applyFolder(path, nodeId),
    });
  }

  private renderAgentSelect(agents: ReturnType<NewSessionPage["agents"]>) {
    return renderAgentSelect({
      agents,
      agentId: this.agentId,
      disabled: this.submitting || Boolean(this.pendingCloud.sessionKey),
      popoverOpen: this.agentPopoverOpen,
      popoverHiding: this.agentPopoverHiding,
      onGuardTransition: (event) => this.guardPopoverTransition(event, this.agentPopoverHiding),
      onPopoverOpenChange: (open) => {
        this.agentPopoverOpen = open;
      },
      onPopoverHidingChange: (hiding) => {
        this.agentPopoverHiding = hiding;
      },
      onRestoreTrigger: () =>
        this.restorePopoverTrigger("new-session-agent-trigger", ".new-session-page__agent-popover"),
      onSelect: (agentId) => this.selectAgentId(agentId),
    });
  }

  /** Where + worktree consolidated into one "run on" menu (Cursor-style). */
  private renderWhereSelect() {
    const execNodes = this.execNodes();
    const cloudProfiles = catalog.isTarget(this.data) ? [] : this.cloudProfiles;
    return renderWhereSelect({
      execNodes: this.isAdmin() ? execNodes : [],
      cloudProfiles: this.isAdmin() ? cloudProfiles : [],
      cloudProfileId: this.cloudProfileId,
      execNode: this.execNode,
      syncFolder: this.folder.trim() || this.workspacePath(),
      worktree: this.worktree,
      worktreeAvailable: this.worktreeAvailable(),
      customFolder: this.usesCustomFolder(),
      branches: this.branches,
      branchesLoading: this.branchesLoading,
      baseRef: this.baseRef,
      worktreeName: this.worktreeName,
      submitting: this.submitting,
      pendingCloud: Boolean(this.pendingCloud.sessionKey),
      showTargets:
        this.isAdmin() &&
        (execNodes.length > 0 || cloudProfiles.length > 0 || Boolean(this.cloudProfileId)),
      popoverOpen: this.wherePopoverOpen,
      popoverHiding: this.wherePopoverHiding,
      onGuardTransition: (event) => this.guardPopoverTransition(event, this.wherePopoverHiding),
      onPopoverOpenChange: (open) => {
        this.wherePopoverOpen = open;
      },
      onPopoverHidingChange: (hiding) => {
        this.wherePopoverHiding = hiding;
      },
      onRestoreTrigger: () =>
        this.restorePopoverTrigger("new-session-where-trigger", ".new-session-page__where-popover"),
      onSelectExecNode: (nodeId) => this.selectExecNode(nodeId),
      onSelectCloudProfile: (profileId) => this.selectCloudProfile(profileId),
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

  private renderFolderSelect() {
    const browseAvailable = this.browseAvailable();
    return renderFolderSelect({
      browseAvailable,
      folder: this.folder,
      execNode: this.execNode,
      workspace: this.workspacePath(),
      browserOpen: this.browserOpen,
      popoverHiding: this.folderPopoverHiding,
      submitting: this.submitting,
      pendingCloud: Boolean(this.pendingCloud.sessionKey),
      browser: this.renderBrowser(),
      onGuardTransition: (event) => this.guardPopoverTransition(event, this.folderPopoverHiding),
      onShow: () => {
        this.browserOpen = true;
        this.showBrowserRoot();
      },
      onHide: () => {
        this.folderPopoverHiding = true;
        if (this.browserOpen) {
          this.closeBrowser();
        }
      },
      onAfterHide: () => {
        this.folderPopoverHiding = false;
        this.restorePopoverTrigger(
          "new-session-folder-trigger",
          ".new-session-page__select--folder",
        );
      },
    });
  }

  private renderTargetBar() {
    const agents = this.agents();
    return catalog.renderBar({
      data: this.data,
      agentSelect: agents.length > 1 ? this.renderAgentSelect(agents) : nothing,
      folderSelect: this.renderFolderSelect(),
      whereSelect: this.renderWhereSelect(),
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
          agentDefaultModel: this.selectedAgent()?.model?.primary,
          agentId: this.agentId,
          attachmentDraft: this.attachmentDraft,
          canSubmit: this.canSubmit(),
          context: this.context,
          isCatalogTarget: catalog.isTarget(this.data),
          message: this.message,
          modelControl: this.modelControl,
          requiresModifier: loadSettings().chatSendShortcut === "modifier-enter",
          submitting: this.submitting,
          messageLocked: Boolean(this.pendingCloud.sessionKey),
          onInput: (message) => {
            if (!this.submitting && !this.pendingCloud.sessionKey) {
              this.message = message;
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
