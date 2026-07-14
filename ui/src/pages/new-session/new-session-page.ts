// Full-page draft: pick agent, host, folder, and worktree, then create on first message.
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { loadSettings } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat.css";
import "../../styles/new-session.css";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import { admitStoredChatComposerQueueItem } from "../chat/composer-persistence.ts";
import * as catalog from "./catalog-target.ts";
import { renderNewSessionComposer } from "./composer.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import {
  type BrowserTarget,
  type DraftBranches,
  type DraftNode,
  readDraftNodes,
} from "./discovery.ts";
import type { NewSessionRouteData } from "./location.ts";
import { handleMenuNavigation, MENU_ITEM_SELECTOR } from "./menu-keyboard.ts";
import { folderDisplayName, isAbsolutePath } from "./path.ts";

const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CATALOG_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

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
  private branchesRequestToken = 0;
  private baseRefEditGeneration = 0;
  private browserRequestToken = 0;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private gatewayClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
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
    const identityChanged =
      !firstBind && (this.gatewaySource !== gateway || this.gatewayClient !== snapshot.client);
    const connectionChanged = !firstBind && this.gatewayConnected !== snapshot.connected;
    const becameConnected = snapshot.connected && (identityChanged || !this.gatewayConnected);
    this.gatewaySource = gateway;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (identityChanged || connectionChanged) {
      this.invalidateGatewayDiscovery(identityChanged);
    }
    if (becameConnected) {
      this.gatewayConnectionEpoch += 1;
      this.retryPendingCatalogTarget();
    }
  }

  private invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.nodesRequestToken += 1;
    this.nodesHydrated = false;
    this.branchesRequestToken += 1;
    this.branchesLoading = false;
    this.branches = null;
    this.baseRef = ""; // Never carry a derived ref across a transport epoch.
    this.agentsHydrated = false;
    this.closeBrowser();
    this.invalidateSubmission(true); // Transport loss makes an in-flight create outcome unknowable.
    if (!resetHostSelection) {
      return;
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

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    this.subscriptions.clear();
    this.invalidateGatewayDiscovery(true);
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.gatewayConnectionEpoch = 0;
    this.catalogRetryScope = "";
    this.catalogRetryAttempt = 0;
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    super.disconnectedCallback();
  }

  private openMenus(): HTMLDetailsElement[] {
    return [...this.querySelectorAll<HTMLDetailsElement>(".new-session-page__select[open]")];
  }

  // Same central dismissal contract as the chat composer's <details> menus:
  // pointerdown outside an open menu closes it, Escape closes and restores
  // trigger focus.
  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    for (const details of this.openMenus()) {
      if (!path.includes(details)) {
        details.open = false;
      }
    }
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    const open = this.openMenus().at(-1);
    if (open) {
      event.stopPropagation();
      open.open = false;
      open.querySelector<HTMLElement>("summary")?.focus();
    }
  };

  // Mutual exclusion must hook the details toggle, not just pointerdown:
  // keyboard activation (Enter/Space on a summary) opens without any pointer
  // event, and two open panels would overlap.
  private readonly handleMenuToggle = (event: Event) => {
    const details = event.currentTarget as HTMLDetailsElement;
    if (this.submitting) {
      // Native details can reopen from keyboard or scripted activation even
      // after the draft becomes inert. Submission owns one frozen snapshot.
      details.open = false;
      return;
    }
    if (!details.open) {
      return;
    }
    for (const other of this.openMenus()) {
      if (other !== details) {
        other.open = false;
      }
    }
    // Keyboard contract of the replaced native selects: opening moves focus
    // into the menu (browser content renders on the next Lit update). The
    // summary sits outside the menu div, so this only skips when the user
    // already focused menu content (e.g. a field).
    void this.updateComplete.then(() => {
      if (!details.open) {
        return;
      }
      const menu = details.querySelector(".new-session-page__menu");
      if (menu && !menu.contains(document.activeElement)) {
        menu.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
      }
    });
  };

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
    // A node cwd belongs to node discovery, not agent workspace refresh.
    if (!this.execNode && !keepSelectedFolder) {
      this.folder = this.workspacePath();
      this.folderSelectedByUser = false;
    }
    void this.loadNodes();
    this.maybeLoadBranches();
  }

  private resetDraft() {
    this.invalidateSubmission();
    this.submissionOutcomeUnknown = false;
    this.agentSelectedByUser = false;
    this.folder = "";
    this.folderSelectedByUser = false;
    this.worktree = false;
    this.worktreeName = "";
    this.baseRef = "";
    this.branches = null;
    this.branchesLoading = false;
    this.execNode = "";
    this.message = "";
    this.error = null;
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

  private canSubmit(): boolean {
    if (
      this.submitting ||
      this.submissionOutcomeUnknown ||
      !this.message.trim() ||
      !this.context?.gateway.snapshot.connected
    ) {
      return false;
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
    if (this.usesCustomFolder() && (!this.isAdmin() || (!this.execNode && !this.worktree))) {
      return false;
    }
    if (this.execNode && this.worktree) {
      return false;
    }
    if (this.worktree && !this.worktreeAvailable()) {
      return false;
    }
    const name = this.worktreeName.trim();
    if (this.worktree && name && !WORKTREE_NAME_PATTERN.test(name)) {
      return false;
    }
    return true;
  }

  private async submit() {
    const context = this.context;
    if (!context || !this.canSubmit()) {
      return;
    }
    const message = this.message.trim();
    const requestId = ++this.submitRequestToken;
    this.submitting = true;
    this.error = null;
    // Collapse menus and retire browser requests before awaiting the Gateway;
    // otherwise a now-hidden picker can keep mutating the submitted draft.
    this.closeBrowser();
    for (const details of this.openMenus()) {
      details.open = false;
    }
    try {
      const result = await context.sessions.createResult(
        buildDraftSessionCreateParams({
          agentId: this.agentId,
          message,
          worktree: this.worktree,
          baseRef: this.baseRef,
          worktreeName: this.worktreeName,
          cwd: this.folder,
          workspace: this.workspacePath(),
          execNode: this.execNode,
          catalogId: this.data?.catalogId,
        }),
      );
      if (requestId !== this.submitRequestToken) {
        return;
      }
      if (!result) {
        this.error = context.sessions.state.error ?? t("newSession.createFailed");
        return;
      }
      if (result.initialRun.status === "rejected") {
        const gateway = context.gateway.snapshot;
        const persisted = admitStoredChatComposerQueueItem(
          {
            settings: loadSettings(),
            assistantAgentId: gateway.assistantAgentId,
            agentsList: context.agents.state.agentsList,
            hello: gateway.hello,
          },
          result.key,
          {
            id: generateUUID(),
            text: message,
            createdAt: Date.now(),
            kind: "queued",
            refreshSessions: true,
            sendAttempts: 1,
            sendError: result.initialRun.error,
            sendState: "failed",
            sessionKey: result.key,
            agentId: normalizeAgentId(this.agentId),
          },
        );
        if (!persisted) {
          // Stay on the draft when browser storage is unavailable: preserving
          // the typed task takes priority over navigating to the partial session.
          this.error = result.initialRun.error;
          return;
        }
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
    if (this.submitting || catalog.isTarget(this.data)) {
      return;
    }
    // Re-picking the checked agent must not reset the draft (the native
    // select never fired change for the same option).
    if (normalizeAgentId(agentId) === normalizeAgentId(this.agentId)) {
      return;
    }
    this.agentId = normalizeAgentId(agentId);
    this.agentSelectedByUser = true;
    this.folder = this.execNode ? "" : this.workspacePath();
    this.folderSelectedByUser = false;
    this.worktree = false;
    this.worktreeName = "";
    this.closeBrowser();
    this.maybeLoadBranches();
  }

  private applyFolder(folder: string, execNode = this.execNode) {
    if (this.submitting) {
      return;
    }
    this.execNode = execNode;
    this.folder = folder.trim();
    this.folderSelectedByUser = true;
    if (this.execNode) {
      this.worktree = false;
    } else if (this.usesCustomFolder()) {
      // Explicit host paths only materialize through a managed worktree.
      this.worktree = true;
    }
    this.maybeLoadBranches();
  }

  private selectExecNode(execNode: string) {
    if (this.submitting) {
      return;
    }
    if (execNode === this.execNode) {
      return;
    }
    this.execNode = execNode;
    // Folder paths belong to one host; never carry a Gateway or node path to another host.
    this.folder = execNode ? "" : this.workspacePath();
    this.folderSelectedByUser = false;
    this.worktree = false;
    this.closeBrowser();
    this.maybeLoadBranches();
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
    // Reset state before collapsing the <details> so its toggle handler sees
    // browserOpen === false and does not re-enter this method.
    this.browserOpen = false;
    this.browserLoading = false;
    this.browserError = null;
    this.browserListing = null;
    this.browserTarget = null;
    this.browserPathDraft = "";
    const details = this.querySelector<HTMLDetailsElement>(
      ".new-session-page__select--folder[open]",
    );
    if (details) {
      details.open = false;
    }
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
    if (!this.browserOpen) {
      return nothing;
    }
    const listing = this.browserListing;
    const target = this.browserTarget;
    // Hosts can answer fs.listDir with a shapeless payload; a missing entries
    // array must read as an empty directory, not crash the render.
    const entries = listing?.entries ?? [];
    return html`
      <div class="new-session-page__browser">
        <div class="new-session-page__browser-head">
          <button
            type="button"
            class="new-session-page__browser-nav"
            title=${t("newSession.browserUp")}
            aria-label=${t("newSession.browserUp")}
            ?disabled=${!target || (!listing && this.browserLoading)}
            @click=${() => {
              if (listing?.parent) {
                this.loadBrowser(listing.parent);
              } else if (target) {
                this.showBrowserRoot();
              }
            }}
          >
            ${icons.arrowLeft}
          </button>
          ${target
            ? html`
                <input
                  class="new-session-page__browser-path"
                  type="text"
                  aria-label=${t("newSession.folder")}
                  placeholder=${target.label}
                  .value=${this.browserPathDraft}
                  @input=${(event: Event) => {
                    this.browserPathDraft = (event.target as HTMLInputElement).value;
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    // Manual path entry browses there; "Use this folder" applies
                    // the typed path even when the host cannot list it.
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const path = this.browserPathDraft.trim();
                      this.loadBrowser(path || undefined);
                    }
                  }}
                />
              `
            : html`<span class="new-session-page__browser-path">${t("newSession.where")}</span>`}
          ${this.browserLoading
            ? html`<span class="new-session-page__browser-loading">${t("common.loading")}</span>`
            : nothing}
          <button
            type="button"
            class="new-session-page__browser-nav"
            title=${t("common.close")}
            aria-label=${t("common.close")}
            @click=${() => this.closeBrowser()}
          >
            ${icons.x}
          </button>
        </div>
        ${this.browserError
          ? html`<div class="new-session-page__error">${this.browserError}</div>`
          : nothing}
        <div class="new-session-page__browser-list" role="listbox">
          ${!target
            ? html`
                <button
                  type="button"
                  class="new-session-page__browser-entry"
                  @click=${() =>
                    this.selectBrowserTarget({ nodeId: "", label: t("newSession.gateway") })}
                >
                  <span class="new-session-page__target-icon" aria-hidden="true"
                    >${icons.monitor}</span
                  >
                  <span>${t("newSession.gateway")}</span>
                </button>
                ${this.nodes.map(
                  (node) => html`
                    <button
                      type="button"
                      class="new-session-page__browser-entry"
                      ?disabled=${!node.canExec}
                      title=${this.nodeBrowseBlockedReason(node) ?? nothing}
                      @click=${() =>
                        this.selectBrowserTarget({
                          nodeId: node.nodeId,
                          label: node.displayName,
                        })}
                    >
                      <span class="new-session-page__target-icon" aria-hidden="true"
                        >${icons.monitor}</span
                      >
                      <span>${node.displayName}</span>
                    </button>
                  `,
                )}
              `
            : nothing}
          ${listing && entries.length === 0 && !this.browserLoading
            ? html`<div class="new-session-page__browser-empty">
                ${t("newSession.browserEmpty")}
              </div>`
            : nothing}
          ${target
            ? entries.map(
                (entry) => html`
                  <button
                    type="button"
                    class="new-session-page__browser-entry ${entry.hidden
                      ? "new-session-page__browser-entry--hidden"
                      : ""}"
                    title=${entry.hidden ? t("newSession.hiddenFolder") : nothing}
                    @click=${() => this.loadBrowser(entry.path)}
                  >
                    <span class="new-session-page__target-icon" aria-hidden="true"
                      >${icons.folder}</span
                    >
                    <span>${entry.name}</span>
                  </button>
                `,
              )
            : nothing}
        </div>
        <div class="new-session-page__browser-actions">
          <button
            type="button"
            class="new-session-page__browser-use"
            ?disabled=${!target || this.usableBrowserPath() === null}
            @click=${() => {
              const path = this.usableBrowserPath();
              if (target && path !== null) {
                this.applyFolder(path, target.nodeId);
                this.closeBrowser();
              }
            }}
          >
            ${t("newSession.browserUse")}
          </button>
        </div>
      </div>
    `;
  }

  /** Closes the menu containing the clicked item and hands focus back. */
  private closeMenuFrom(event: Event) {
    const details = (event.currentTarget as HTMLElement).closest("details");
    if (details?.open) {
      details.open = false;
      details.querySelector<HTMLElement>("summary")?.focus();
    }
  }

  private renderMenuItem(params: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    title?: string;
    onSelect: (event: Event) => void;
  }) {
    return html`
      <button
        type="button"
        class="session-menu__item"
        role="menuitemradio"
        aria-checked=${String(params.checked)}
        title=${params.title ?? nothing}
        ?disabled=${this.submitting || (params.disabled ?? false)}
        @click=${params.onSelect}
      >
        <span class="session-menu__check" aria-hidden="true"
          >${params.checked ? icons.check : nothing}</span
        >
        <span class="session-menu__text">${params.label}</span>
      </button>
    `;
  }

  private renderAgentSelect(agents: ReturnType<NewSessionPage["agents"]>) {
    const selected = this.selectedAgent();
    const label = selected?.identity?.name ?? selected?.name ?? selected?.id ?? this.agentId;
    return html`
      <details class="new-session-page__select" @toggle=${this.handleMenuToggle}>
        <summary
          class="new-session-page__trigger"
          title=${t("newSession.agent")}
          aria-disabled=${String(this.submitting)}
          @click=${(event: Event) => {
            if (this.submitting) {
              event.preventDefault();
            }
          }}
        >
          <span class="new-session-page__target-icon" aria-hidden="true">${icons.bot}</span>
          <span class="new-session-page__trigger-label">${label}</span>
          <span class="new-session-page__trigger-chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </summary>
        <div
          class="new-session-page__menu"
          role="menu"
          aria-label=${t("newSession.agent")}
          @keydown=${handleMenuNavigation}
        >
          ${agents.map((option) =>
            this.renderMenuItem({
              label: option.identity?.name ?? option.name ?? option.id,
              checked: normalizeAgentId(option.id) === this.agentId,
              onSelect: (event) => {
                this.selectAgentId(option.id);
                this.closeMenuFrom(event);
              },
            }),
          )}
        </div>
      </details>
    `;
  }

  /** Where + worktree consolidated into one "run on" menu (Cursor-style). */
  private renderWhereSelect() {
    const execNodes = this.execNodes();
    const showNodes = this.isAdmin() && execNodes.length > 0;
    const activeNode = execNodes.find((node) => node.nodeId === this.execNode);
    const whereLabel = this.execNode
      ? (activeNode?.displayName ?? this.execNode)
      : t("newSession.gateway");
    const customFolder = this.usesCustomFolder();
    const worktreeAvailable = this.worktreeAvailable();
    const branches = this.branches;
    return html`
      <details class="new-session-page__select" @toggle=${this.handleMenuToggle}>
        <summary
          class="new-session-page__trigger"
          title=${t("newSession.where")}
          data-worktree=${String(this.worktree)}
          aria-disabled=${String(this.submitting)}
          @click=${(event: Event) => {
            if (this.submitting) {
              event.preventDefault();
            }
          }}
        >
          <span class="new-session-page__target-icon" aria-hidden="true">${icons.monitor}</span>
          <span class="new-session-page__trigger-label">${whereLabel}</span>
          ${this.worktree
            ? html`<span class="new-session-page__target-icon" aria-hidden="true"
                >${icons.gitBranch}</span
              >`
            : nothing}
          <span class="new-session-page__trigger-chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </summary>
        <div
          class="new-session-page__menu"
          role="menu"
          aria-label=${t("newSession.where")}
          @keydown=${handleMenuNavigation}
        >
          ${showNodes
            ? html`
                <div class="new-session-page__menu-title">${t("newSession.where")}</div>
                ${this.renderMenuItem({
                  label: t("newSession.gateway"),
                  checked: !this.execNode,
                  onSelect: (event) => {
                    this.selectExecNode("");
                    this.closeMenuFrom(event);
                  },
                })}
                ${execNodes.map((node) =>
                  this.renderMenuItem({
                    label: node.displayName,
                    checked: this.execNode === node.nodeId,
                    onSelect: (event) => {
                      this.selectExecNode(node.nodeId);
                      this.closeMenuFrom(event);
                    },
                  }),
                )}
              `
            : nothing}
          ${!this.execNode
            ? html`
                ${showNodes
                  ? html`<div class="session-menu__separator" role="separator"></div>`
                  : nothing}
                ${this.renderMenuItem({
                  label: t("newSession.worktree"),
                  checked: this.worktree,
                  disabled: !worktreeAvailable || customFolder,
                  title: worktreeAvailable
                    ? t("chat.runControls.newSessionWorktree")
                    : t("newSession.worktreeUnavailable"),
                  onSelect: () => {
                    // Stays open: enabling reveals the branch/name fields below.
                    this.worktree = !this.worktree;
                    if (this.worktree) {
                      this.maybeLoadBranches();
                    }
                  },
                })}
                ${this.worktree
                  ? html`
                      <label class="new-session-page__menu-field">
                        <span>${t("newSession.baseBranch")}</span>
                        <input
                          type="text"
                          list="new-session-branches"
                          ?disabled=${this.submitting}
                          placeholder=${this.branchesLoading
                            ? t("common.loading")
                            : (branches?.defaultBranch ?? t("newSession.baseBranch"))}
                          .value=${this.baseRef}
                          @input=${(event: Event) => {
                            if (this.submitting) {
                              return;
                            }
                            this.baseRefEditGeneration += 1;
                            this.baseRef = (event.target as HTMLInputElement).value.trim();
                          }}
                        />
                        <datalist id="new-session-branches">
                          ${(branches?.branches ?? []).map(
                            (branch) => html`<option value=${branch.name}></option>`,
                          )}
                        </datalist>
                      </label>
                      <label class="new-session-page__menu-field">
                        <span>${t("newSession.worktreeName")}</span>
                        <input
                          type="text"
                          ?disabled=${this.submitting}
                          placeholder=${t("newSession.worktreeNamePlaceholder")}
                          .value=${this.worktreeName}
                          @input=${(event: Event) => {
                            if (this.submitting) {
                              return;
                            }
                            this.worktreeName = (event.target as HTMLInputElement).value.trim();
                          }}
                        />
                      </label>
                    `
                  : nothing}
              `
            : nothing}
        </div>
      </details>
    `;
  }

  private renderFolderSelect() {
    const browseAvailable = this.browseAvailable();
    const folder = this.folder.trim();
    // An empty folder on a node session means that node's default directory —
    // never the Gateway workspace, so no local-workspace fallback there.
    const label = folder
      ? folderDisplayName(folder)
      : this.execNode
        ? t("newSession.folderPlaceholder")
        : folderDisplayName(this.workspacePath()) || t("newSession.folderPlaceholder");
    return html`
      <details
        class="new-session-page__select new-session-page__select--folder"
        @toggle=${(event: Event) => {
          // Browser state first: handleMenuToggle captures updateComplete for
          // its focus hook, which must wait for the render these setters
          // schedule (a bare details-attribute flip schedules none).
          const details = event.currentTarget as HTMLDetailsElement;
          if (details.open) {
            this.browserOpen = true;
            this.showBrowserRoot();
          } else if (this.browserOpen) {
            this.closeBrowser();
          }
          this.handleMenuToggle(event);
        }}
      >
        <summary
          class="new-session-page__trigger ${browseAvailable
            ? ""
            : "new-session-page__trigger--disabled"}"
          title=${browseAvailable ? t("newSession.browse") : t("newSession.browseRequiresAdmin")}
          aria-disabled=${String(this.submitting || !browseAvailable)}
          @click=${(event: Event) => {
            if (this.submitting || !browseAvailable) {
              event.preventDefault();
            }
          }}
        >
          <span class="new-session-page__target-icon" aria-hidden="true">${icons.folder}</span>
          <span class="new-session-page__trigger-label">${label}</span>
          <span class="new-session-page__trigger-chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </summary>
        <div
          class="new-session-page__menu new-session-page__menu--browser"
          @keydown=${handleMenuNavigation}
        >
          ${this.renderBrowser()}
        </div>
      </details>
    `;
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
    const worktreeNameInvalid =
      this.worktree &&
      this.worktreeName.trim() !== "" &&
      !WORKTREE_NAME_PATTERN.test(this.worktreeName.trim());
    return html`
      <div class="new-session-page__draft" aria-busy=${String(this.submitting)}>
        ${this.renderTargetBar()}
        ${worktreeNameInvalid
          ? html`<div class="new-session-page__error">${t("newSession.worktreeNameInvalid")}</div>`
          : nothing}
        ${this.error ? html`<div class="new-session-page__error">${this.error}</div>` : nothing}
        ${this.submissionOutcomeUnknown
          ? html`<div class="new-session-page__error">${t("newSession.createOutcomeUnknown")}</div>`
          : nothing}
        ${renderNewSessionComposer({
          canSubmit: this.canSubmit(),
          message: this.message,
          requiresModifier: loadSettings().chatSendShortcut === "modifier-enter",
          submitting: this.submitting,
          onInput: (message) => {
            if (!this.submitting) {
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
        if (!this.submitting) {
          this.message = next;
        }
      },
      onSend: () => void this.submit(),
      onOpenSession: (sessionKey) => {
        if (this.submitting) {
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
