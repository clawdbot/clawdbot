import { consume } from "@lit/context";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { applicationContext, type ApplicationGatewaySnapshot } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { renderPluginsHubTabs } from "../../components/plugins-hub-tabs.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionKey, searchForSession } from "../../lib/sessions/index.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { filterSkillWorkshopProposals } from "../../lib/skill-workshop/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderSkillWorkshopHeaderControls, setSkillWorkshopMode } from "./header-controls.ts";
import {
  loadSkillWorkshopPageData,
  runSkillWorkshopPageHistoryScan,
} from "./history-scan-page-controller.ts";
import type {
  SkillWorkshopProposal,
  SkillWorkshopRenderContext,
  SkillWorkshopRevisionRequest,
} from "./page-types.ts";
import { selectPluginsHubTab } from "./plugins-hub-navigation.ts";
import {
  countSkillWorkshopProposals,
  createSkillWorkshopState,
  loadSkillWorkshopProposals,
  requestSkillWorkshopRevision,
  runSkillWorkshopLifecycleAction,
  selectSkillWorkshopProposal,
  type SkillWorkshopRouteData,
  type SkillWorkshopState,
} from "./proposals.ts";
import { resolveSelfLearning, setSelfLearningEnabled } from "./self-learning.ts";
import {
  captureSkillWorkshopSourceScope,
  isCurrentSkillWorkshopSourceScope,
  type SkillWorkshopPageContext,
  type SkillWorkshopSourceScope,
} from "./source-scope.ts";
import { loadSkillWorkshopMode, loadSkillWorkshopUseCurrentChatForRevisions } from "./storage.ts";
import { renderSkillWorkshop } from "./view.ts";

function findRevisionSessionRow(
  result: SessionsListResult | null,
  sessionKey: string | undefined,
): GatewaySessionRow | null {
  const key = sessionKey?.trim();
  return key ? (result?.sessions.find((row) => row.key === key) ?? null) : null;
}

function isUsableRevisionSession(row: GatewaySessionRow | null): row is GatewaySessionRow {
  return Boolean(row && !row.archived && !row.hasActiveRun);
}

async function loadRevisionSessionsForAgent(
  context: SkillWorkshopPageContext,
  agentId: string,
): Promise<SessionsListResult | null> {
  const current = context.sessions.state;
  if (current.agentId === agentId && current.result?.sessions.length) {
    return current.result;
  }
  return context.sessions.list({ agentId });
}

async function resolveRevisionSessionKey(
  state: SkillWorkshopState,
  context: SkillWorkshopPageContext,
  proposal: SkillWorkshopProposal,
  proposalAgentId: string,
): Promise<string | null> {
  const gatewayHello = context.gateway.snapshot.hello;
  if (state.skillWorkshopUseCurrentChatForRevisions) {
    return resolveSessionKey(loadSettings().sessionKey, gatewayHello).trim() || null;
  }

  const agentId = normalizeAgentId(proposal.origin?.agentId ?? proposalAgentId);
  const sessions = await loadRevisionSessionsForAgent(context, agentId);
  const originRow = findRevisionSessionRow(sessions, proposal.origin?.sessionKey);
  if (isUsableRevisionSession(originRow)) {
    return originRow.key;
  }

  const createdKey = await context.sessions.create({
    agentId,
    label: truncateUtf16Safe(`Skill Workshop: ${proposal.slug || proposal.key}`, 80),
  });
  const sessionKey = resolveSessionKey(createdKey, gatewayHello).trim();
  if (!sessionKey) {
    throw new Error(context.sessions.state.error ?? "Could not prepare a Skill Workshop session.");
  }
  return sessionKey;
}

function renderSkillWorkshopPage(
  state: SkillWorkshopState,
  renderContext: SkillWorkshopRenderContext,
  requestUpdate: () => void,
) {
  const {
    context,
    workshopAgentName,
    onRevisionRequest,
    selfLearning,
    onSelfLearningToggle,
    onHistoryScan,
  } = renderContext;
  const pageClass =
    state.skillWorkshopMode === "today"
      ? "content--skill-workshop content--skill-workshop-today"
      : "content--skill-workshop";

  return html`
    <section class=${pageClass}>
      <section class="content-header content-header--page plugins-content-header">
        <div>
          <h1 class="page-title">${t("tabs.skillWorkshop")}</h1>
        </div>
        <div class="page-meta">
          ${renderSkillWorkshopHeaderControls(state, renderContext, requestUpdate)}
        </div>
      </section>
      <div class="plugins-hub-tabs-row">
        ${renderPluginsHubTabs({
          active: "workshop",
          onSelect: (tab) => selectPluginsHubTab(context, tab),
        })}
      </div>
      <wa-tab-panel
        id="plugins-hub-panel"
        class="sw-hub-panel"
        name="workshop"
        active
        aria-labelledby="plugins-tab-workshop"
      >
        ${(() => {
          const visibleProposals = filterSkillWorkshopProposals(
            state.skillWorkshopProposals,
            state.skillWorkshopStatusFilter,
            state.skillWorkshopQuery,
          );
          const selectedIndex = visibleProposals.findIndex(
            (proposal) => proposal.key === state.skillWorkshopSelectedKey,
          );
          const selectProposal = (key: string) => {
            state.skillWorkshopFilePreviewKey = null;
            void selectSkillWorkshopProposal(state, context, key).finally(requestUpdate);
            requestUpdate();
          };
          const selectRelativeProposal = (delta: -1 | 1) => {
            if (visibleProposals.length === 0) {
              return;
            }
            const nextIndex =
              selectedIndex < 0
                ? 0
                : (selectedIndex + delta + visibleProposals.length) % visibleProposals.length;
            const nextProposal = visibleProposals[nextIndex];
            if (nextProposal) {
              selectProposal(nextProposal.key);
            }
          };
          const selectVisibleFallback = (proposals: typeof visibleProposals) => {
            if (
              proposals.length === 0 ||
              proposals.some((proposal) => proposal.key === state.skillWorkshopSelectedKey)
            ) {
              return;
            }
            const firstProposal = proposals[0];
            if (firstProposal) {
              selectProposal(firstProposal.key);
            }
          };
          return html`<wa-tab-panel
            id="skill-workshop-mode-panel"
            name=${state.skillWorkshopMode}
            active
            aria-labelledby=${`skill-workshop-mode-tab-${state.skillWorkshopMode}`}
          >
            ${renderSkillWorkshop({
              loading: state.skillWorkshopLoading,
              error: state.skillWorkshopError,
              inspectingKey: state.skillWorkshopInspectingKey,
              proposals: state.skillWorkshopProposals,
              selectedKey: state.skillWorkshopSelectedKey,
              statusFilter: state.skillWorkshopStatusFilter,
              query: state.skillWorkshopQuery,
              filePreviewKey: state.skillWorkshopFilePreviewKey,
              filePreviewQuery: state.skillWorkshopFilePreviewQuery,
              queueWidth: state.skillWorkshopQueueWidth,
              mode: state.skillWorkshopMode,
              actionBusy: state.skillWorkshopActionBusy,
              actionNotice: state.skillWorkshopActionNotice,
              revisionKey: state.skillWorkshopRevisionKey,
              revisionDraft: state.skillWorkshopRevisionDraft,
              assistantName: context.config.current.assistantIdentity.name,
              workshopAgentName,
              selfLearning,
              historyScan: state.skillWorkshopHistoryScan,
              counts: countSkillWorkshopProposals(state.skillWorkshopProposals),
              onRetry: () => {
                // Force past the loaded/error latch; the loading guard still
                // prevents duplicate in-flight requests.
                void loadSkillWorkshopProposals(state, context, { force: true }).finally(
                  requestUpdate,
                );
                requestUpdate();
              },
              onStatusFilterChange: (status) => {
                state.skillWorkshopStatusFilter = status;
                requestUpdate();
                selectVisibleFallback(
                  filterSkillWorkshopProposals(
                    state.skillWorkshopProposals,
                    status,
                    state.skillWorkshopQuery,
                  ),
                );
              },
              onQueryChange: (query) => {
                state.skillWorkshopQuery = query;
                requestUpdate();
                selectVisibleFallback(
                  filterSkillWorkshopProposals(
                    state.skillWorkshopProposals,
                    state.skillWorkshopStatusFilter,
                    query,
                  ),
                );
              },
              onFilePreviewQueryChange: (query) => {
                state.skillWorkshopFilePreviewQuery = query;
                requestUpdate();
              },
              onQueueWidthChange: (width) => {
                state.skillWorkshopQueueWidth = width;
                requestUpdate();
              },
              onModeChange: (mode) => setSkillWorkshopMode(state, mode, requestUpdate),
              onSelect: selectProposal,
              onPrev: () => selectRelativeProposal(-1),
              onNext: () => selectRelativeProposal(1),
              onApply: (key) => {
                void runSkillWorkshopLifecycleAction(state, context, "apply", key).finally(
                  requestUpdate,
                );
                requestUpdate();
              },
              onRevise: (key) => {
                state.skillWorkshopRevisionKey = key;
                state.skillWorkshopRevisionDraft = "";
                requestUpdate();
              },
              onReject: (key) => {
                void runSkillWorkshopLifecycleAction(state, context, "reject", key).finally(
                  requestUpdate,
                );
                requestUpdate();
              },
              onRevisionDraftChange: (draft) => {
                state.skillWorkshopRevisionDraft = draft;
                requestUpdate();
              },
              onRevisionCancel: () => {
                state.skillWorkshopRevisionKey = null;
                state.skillWorkshopRevisionDraft = "";
                requestUpdate();
              },
              onRevisionSubmit: (key) =>
                onRevisionRequest
                  ? void requestSkillWorkshopRevision(
                      state,
                      context,
                      key,
                      onRevisionRequest,
                    ).finally(requestUpdate)
                  : undefined,
              onPreviewFile: (key, path) => {
                state.skillWorkshopSelectedKey = key;
                state.skillWorkshopFilePreviewKey = path;
                requestUpdate();
              },
              onClosePreview: () => {
                state.skillWorkshopFilePreviewKey = null;
                state.skillWorkshopFilePreviewQuery = "";
                requestUpdate();
              },
              onSelfLearningToggle,
              onHistoryScan,
            })}
          </wa-tab-panel>`;
        })()}
      </wa-tab-panel>
    </section>
  `;
}

class SkillWorkshopPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: SkillWorkshopPageContext;
  @property({ attribute: false }) data?: SkillWorkshopRouteData;
  @property({ attribute: false }) onRevisionRequest?: SkillWorkshopRevisionRequest;

  private state?: SkillWorkshopState;
  private sourceEpoch = 0;
  private hasBoundContext = false;
  private contextSource?: SkillWorkshopPageContext;
  private gatewaySource?: SkillWorkshopPageContext["gateway"];
  private gatewayClient: SkillWorkshopPageContext["gateway"]["snapshot"]["client"] = null;
  private gatewayConnected = false;
  private hasBoundAgentSelection = false;
  private agentSelectionSource?: SkillWorkshopPageContext["agentSelection"];
  private selectedAgentId?: string | null;
  private hasBoundSessions = false;
  private sessionsSource?: SkillWorkshopPageContext["sessions"];
  private selfLearningBusy = false;
  private selfLearningError: string | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context,
      (context) => {
        const sourceChanged = this.hasBoundContext && this.contextSource !== context;
        this.hasBoundContext = true;
        this.contextSource = context;
        if (sourceChanged) {
          const gateway = context.gateway;
          this.gatewaySource = gateway;
          this.gatewayClient = gateway.snapshot.client;
          this.gatewayConnected = gateway.snapshot.connected;
          this.agentSelectionSource = context.agentSelection;
          this.selectedAgentId = context.agentSelection.state.selectedId;
          this.sessionsSource = context.sessions;
          this.resetSourceState();
          this.loadProposals(true);
        }
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const snapshot = gateway.snapshot;
        const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
        const clientChanged =
          this.gatewaySource !== undefined && this.gatewayClient !== snapshot.client;
        const connectionChanged =
          this.gatewaySource !== undefined && this.gatewayConnected !== snapshot.connected;
        this.applyGatewaySnapshot(
          gateway,
          snapshot,
          sourceChanged || clientChanged || connectionChanged,
        );
        const cleanup = gateway.subscribe((nextSnapshot) => {
          if (this.gatewaySource !== gateway || this.context?.gateway !== gateway) {
            return;
          }
          const sourceEpochChanged =
            nextSnapshot.client !== this.gatewayClient ||
            nextSnapshot.connected !== this.gatewayConnected;
          this.applyGatewaySnapshot(gateway, nextSnapshot, sourceEpochChanged);
        });
        return cleanup;
      },
    )
    .watch(
      () => this.context?.config,
      (config, notify) => config.subscribe(notify),
    )
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => {
        let resetForSourceBind =
          this.hasBoundAgentSelection && this.agentSelectionSource !== agentSelection;
        this.hasBoundAgentSelection = true;
        this.agentSelectionSource = agentSelection;
        let initialNotification = true;
        const handleChange = () => {
          if (
            this.agentSelectionSource !== agentSelection ||
            this.context?.agentSelection !== agentSelection
          ) {
            return;
          }
          const nextAgentId = agentSelection.state.selectedId;
          const agentChanged = !initialNotification && this.selectedAgentId !== nextAgentId;
          this.selectedAgentId = nextAgentId;
          const sourceEpochChanged = resetForSourceBind || agentChanged;
          resetForSourceBind = false;
          initialNotification = false;
          if (sourceEpochChanged) {
            this.resetSourceState();
          }
          this.loadProposals(sourceEpochChanged);
        };
        handleChange();
        return agentSelection.subscribe(handleChange);
      },
    )
    .effect(
      () => this.context?.sessions,
      (sessions) => {
        const sourceChanged = this.hasBoundSessions && this.sessionsSource !== sessions;
        this.hasBoundSessions = true;
        this.sessionsSource = sessions;
        if (sourceChanged) {
          this.resetSourceState();
          this.loadProposals(true);
        }
      },
    )
    .watch(
      () => this.context?.agentIdentity,
      (agentIdentity, notify) => agentIdentity.subscribe(notify),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
    );

  private readonly handleRevisionRequest: SkillWorkshopRevisionRequest = async (
    instructions,
    proposal,
    proposalAgentId,
  ) => {
    const scope = this.captureSourceScope();
    if (!scope) {
      throw new Error("Skill Workshop is not ready.");
    }
    let sessionKey: string | null;
    try {
      sessionKey = await resolveRevisionSessionKey(
        scope.state,
        scope.context,
        proposal,
        proposalAgentId,
      );
    } catch (error) {
      if (!this.isCurrentSourceScope(scope)) {
        return;
      }
      throw error;
    }
    if (!this.isCurrentSourceScope(scope)) {
      return;
    }
    if (!sessionKey) {
      throw new Error(scope.sessions.state.error ?? "Could not prepare a Skill Workshop session.");
    }
    try {
      scope.revision.prepare({
        sessionKey,
        instructions,
        proposalId: proposal.key,
        proposalAgentId: normalizeAgentId(proposal.origin?.agentId ?? proposalAgentId),
      });
    } catch (error) {
      if (!this.isCurrentSourceScope(scope)) {
        return;
      }
      throw error;
    }
    if (!this.isCurrentSourceScope(scope)) {
      return;
    }
    scope.navigate("chat", { search: searchForSession(sessionKey) });
  };

  override willUpdate() {
    if (!this.state && this.context) {
      this.state = createSkillWorkshopState(this.data);
      this.state.skillWorkshopMode = loadSkillWorkshopMode();
      this.state.skillWorkshopUseCurrentChatForRevisions =
        loadSkillWorkshopUseCurrentChatForRevisions();
    }
  }

  override updated() {
    // Only kick a load when none is in flight and the last attempt did not
    // fail: loadProposals early-returns resolve immediately and their finally
    // schedules another update, so re-kicking here would spin forever when a
    // load stays pending or the gateway keeps erroring.
    const state = this.state;
    const canLoad =
      state &&
      !state.skillWorkshopLoaded &&
      !state.skillWorkshopLoading &&
      !state.skillWorkshopError;
    if (this.gatewayConnected && canLoad) {
      this.loadProposals(false);
    }
    this.ensureWorkshopAgentIdentity();
    const runtimeConfig = this.context?.runtimeConfig;
    if (
      runtimeConfig &&
      this.gatewayConnected &&
      !runtimeConfig.state.configSnapshot &&
      !runtimeConfig.state.configLoading
    ) {
      void runtimeConfig.ensureLoaded();
    }
  }

  private readonly requestPageUpdate = () => {
    if (this.isConnected) {
      this.requestUpdate();
    }
  };

  private resetSourceState() {
    this.sourceEpoch += 1;
    const previous = this.state;
    if (!previous) {
      return;
    }
    if (previous.skillWorkshopActionNoticeTimer) {
      globalThis.clearTimeout(previous.skillWorkshopActionNoticeTimer);
    }
    const next = createSkillWorkshopState();
    next.skillWorkshopStatusFilter = previous.skillWorkshopStatusFilter;
    next.skillWorkshopQuery = previous.skillWorkshopQuery;
    next.skillWorkshopQueueWidth = previous.skillWorkshopQueueWidth;
    next.skillWorkshopMode = previous.skillWorkshopMode;
    next.skillWorkshopUseCurrentChatForRevisions = previous.skillWorkshopUseCurrentChatForRevisions;
    this.state = next;
    this.requestPageUpdate();
  }

  private applyGatewaySnapshot(
    gateway: SkillWorkshopPageContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    sourceEpochChanged: boolean,
  ) {
    this.gatewaySource = gateway;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (sourceEpochChanged) {
      this.resetSourceState();
    }
    if (snapshot.connected && (sourceEpochChanged || !this.state?.skillWorkshopLoaded)) {
      this.loadProposals(sourceEpochChanged);
    }
  }

  private captureSourceScope(): SkillWorkshopSourceScope | null {
    return captureSkillWorkshopSourceScope({
      state: this.state,
      context: this.context,
      epoch: this.sourceEpoch,
    });
  }

  private isCurrentSourceScope(scope: SkillWorkshopSourceScope): boolean {
    return isCurrentSkillWorkshopSourceScope(scope, {
      state: this.state,
      context: this.context,
      epoch: this.sourceEpoch,
    });
  }

  private loadProposals(force: boolean) {
    const state = this.state;
    const context = this.context;
    if (!state || !context || !context.gateway.snapshot.connected) {
      return;
    }
    void loadSkillWorkshopPageData({ state, context, force }).finally(this.requestPageUpdate);
  }

  private readonly handleHistoryScan = () => {
    const scope = this.captureSourceScope();
    if (!scope) {
      return;
    }
    void runSkillWorkshopPageHistoryScan({
      state: scope.state,
      context: scope.context,
      current: () => {
        const state = this.state;
        const context = this.context;
        return state && context ? { state, context } : undefined;
      },
    }).finally(this.requestPageUpdate);
    this.requestPageUpdate();
  };

  private readonly handleSelfLearningToggle = (enabled: boolean) => {
    void this.applySelfLearningToggle(enabled);
  };

  private async applySelfLearningToggle(enabled: boolean): Promise<void> {
    const runtimeConfig = this.context?.runtimeConfig;
    if (!runtimeConfig || this.selfLearningBusy) {
      return;
    }
    this.selfLearningBusy = true;
    this.selfLearningError = null;
    this.requestPageUpdate();
    try {
      this.selfLearningError = await setSelfLearningEnabled(runtimeConfig, enabled);
    } finally {
      this.selfLearningBusy = false;
      this.requestPageUpdate();
    }
  }

  private ensureWorkshopAgentIdentity(): void {
    const context = this.context;
    const agentId = this.state?.skillWorkshopAgentId;
    if (!context || !agentId || context.agentIdentity.get(agentId)) {
      return;
    }
    void context.agentIdentity.ensure([agentId]);
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.resetSourceState();
    super.disconnectedCallback();
  }

  override render() {
    return this.state && this.context
      ? renderSkillWorkshopPage(
          this.state,
          {
            context: this.context,
            workshopAgentName:
              this.context.agentIdentity.get(this.state.skillWorkshopAgentId)?.name?.trim() ?? "",
            onRevisionRequest: this.onRevisionRequest ?? this.handleRevisionRequest,
            selfLearning: resolveSelfLearning(
              this.context.runtimeConfig,
              this.selfLearningBusy,
              this.selfLearningError,
            ),
            onSelfLearningToggle: this.handleSelfLearningToggle,
            onHistoryScan: this.handleHistoryScan,
          },
          this.requestPageUpdate,
        )
      : nothing;
  }
}

if (!customElements.get("openclaw-skill-workshop-page")) {
  customElements.define("openclaw-skill-workshop-page", SkillWorkshopPage);
}
