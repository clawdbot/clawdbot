import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationGatewaySnapshot } from "../../app/context.ts";
import "../../components/tooltip.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import {
  filterSkillWorkshopProposals,
  type SkillWorkshopAppliedDiffMode,
} from "../../lib/skill-workshop/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { canCallWorkshopAdminMethod, resolveWorkshopAccess } from "./access.ts";
import { renderSkillWorkshopHeaderControls, setSkillWorkshopMode } from "./header-controls.ts";
import {
  loadSkillWorkshopPageData,
  runSkillWorkshopPageHistoryScan,
} from "./history-scan-page-controller.ts";
import type { SkillWorkshopRenderContext, SkillWorkshopRevisionRequest } from "./page-types.ts";
import { selectPluginsHubTab } from "./plugins-hub-navigation.ts";
import {
  countSkillWorkshopProposals,
  createSkillWorkshopState,
  requestSkillWorkshopRevision,
  runSkillWorkshopEvaluation,
  runSkillWorkshopLifecycleAction,
  selectSkillWorkshopProposal,
  type SkillWorkshopRouteData,
  type SkillWorkshopState,
} from "./proposals.ts";
import { resolveSkillWorkshopRevisionSessionKey } from "./revision-session.ts";
import { resolveSelfLearning, setSelfLearningEnabled } from "./self-learning.ts";
import {
  captureSkillWorkshopSourceScope,
  isCurrentSkillWorkshopSourceScope,
  type SkillWorkshopPageContext,
  type SkillWorkshopSourceScope,
} from "./source-scope.ts";
import { loadSkillWorkshopMode, loadSkillWorkshopUseCurrentChatForRevisions } from "./storage.ts";
import { renderSkillWorkshop } from "./view.ts";

function renderSkillWorkshopPage(
  state: SkillWorkshopState,
  renderContext: SkillWorkshopRenderContext,
  requestUpdate: () => void,
) {
  const {
    context,
    workshopAgentName,
    onEvaluate,
    onRevisionSubmit,
    selfLearning,
    onSelfLearningToggle,
    onHistoryScan,
    onRetry,
  } = renderContext;
  const pageClass =
    state.skillWorkshopMode === "today"
      ? "content--skill-workshop content--skill-workshop-today"
      : "content--skill-workshop";
  const access = resolveWorkshopAccess(context.gateway.snapshot);

  return html`
    <section class=${pageClass}>
      ${renderPluginsHubHeader({
        active: "workshop",
        onSelect: (tab) => selectPluginsHubTab(context, tab),
      })}
      <wa-tab-panel
        id=${PLUGINS_HUB_PANEL_ID}
        class="sw-hub-panel"
        name="workshop"
        active
        aria-labelledby="plugins-tab-workshop"
      >
        <div class="sw-workshop-toolbar">
          ${renderSkillWorkshopHeaderControls(state, renderContext, requestUpdate)}
        </div>
        ${(() => {
          const visibleProposals = filterSkillWorkshopProposals(
            state.skillWorkshopProposals,
            state.skillWorkshopStatusFilter,
            state.skillWorkshopQuery,
          );
          const selectedProposal = state.skillWorkshopProposals.find(
            (proposal) => proposal.key === state.skillWorkshopSelectedKey,
          );
          const isSelectedProposal = (proposal: (typeof visibleProposals)[number]) =>
            proposal.key === state.skillWorkshopSelectedKey ||
            (state.skillWorkshopStatusFilter === "applied" &&
              selectedProposal?.status === "applied" &&
              proposal.slug === selectedProposal?.slug);
          const selectedIndex = visibleProposals.findIndex(isSelectedProposal);
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
            if (proposals.length === 0 || proposals.some(isSelectedProposal)) {
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
              access,
              loading: state.skillWorkshopLoading,
              error: state.skillWorkshopError,
              inspectingKey: state.skillWorkshopInspectingKey,
              proposals: state.skillWorkshopProposals,
              selectedKey: state.skillWorkshopSelectedKey,
              appliedDiffMode: state.skillWorkshopAppliedDiffMode,
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
                onRetry();
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
              onAppliedDiffModeChange: (mode: SkillWorkshopAppliedDiffMode) => {
                state.skillWorkshopAppliedDiffMode = mode;
                requestUpdate();
              },
              onPrev: () => selectRelativeProposal(-1),
              onNext: () => selectRelativeProposal(1),
              onApply: (key) => {
                if (
                  !canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.proposals.apply")
                ) {
                  return;
                }
                void runSkillWorkshopLifecycleAction(state, context, "apply", key).finally(
                  requestUpdate,
                );
                requestUpdate();
              },
              onEvaluate: (key) => {
                if (
                  !canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.proposals.evaluate")
                ) {
                  return;
                }
                onEvaluate(key);
                requestUpdate();
              },
              onRevise: (key) => {
                if (
                  !canCallWorkshopAdminMethod(
                    context.gateway.snapshot,
                    "skills.proposals.requestRevision",
                  )
                ) {
                  return;
                }
                state.skillWorkshopRevisionKey = key;
                state.skillWorkshopRevisionDraft = "";
                requestUpdate();
              },
              onReject: (key) => {
                if (
                  !canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.proposals.reject")
                ) {
                  return;
                }
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
                canCallWorkshopAdminMethod(
                  context.gateway.snapshot,
                  "skills.proposals.requestRevision",
                )
                  ? onRevisionSubmit(key)
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
  private operationEpoch = 0;
  private hasBoundContext = false;
  private contextSource?: SkillWorkshopPageContext;
  private gatewaySource?: SkillWorkshopPageContext["gateway"];
  private gatewayClient: SkillWorkshopPageContext["gateway"]["snapshot"]["client"] = null;
  private gatewayHello: SkillWorkshopPageContext["gateway"]["snapshot"]["hello"] = null;
  private gatewayConnected = false;
  private hasBoundAgentSelection = false;
  private agentSelectionSource?: SkillWorkshopPageContext["agentSelection"];
  private selectedAgentId?: string | null;
  private hasBoundSessions = false;
  private sessionsSource?: SkillWorkshopPageContext["sessions"];
  private selfLearningBusy = false;
  private selfLearningError: string | null = null;
  private readonly proposalsTask = new Task(this, {
    autoRun: false,
    // State and context identities isolate helper mutations after any source reset.
    args: () =>
      [
        this.gatewayConnected ? (this.context ?? null) : null,
        this.gatewayConnected ? (this.state ?? null) : null,
        this.selectedAgentId ?? null,
        false as boolean,
      ] as const,
    task: ([context, state, _agentId, force]) =>
      context && state ? loadSkillWorkshopPageData({ state, context, force }) : initialState,
    onComplete: () => {
      this.requestPageUpdate();
    },
    onError: () => {
      this.requestPageUpdate();
    },
  });
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
          this.gatewayHello = gateway.snapshot.hello;
          this.gatewayConnected = gateway.snapshot.phase === "connected";
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
          this.gatewaySource !== undefined &&
          this.gatewayConnected !== (snapshot.phase === "connected");
        const helloChanged =
          this.gatewaySource !== undefined && this.gatewayHello !== snapshot.hello;
        this.applyGatewaySnapshot(
          gateway,
          snapshot,
          sourceChanged || clientChanged || connectionChanged || helloChanged,
        );
        const cleanup = gateway.subscribe((nextSnapshot) => {
          if (this.gatewaySource !== gateway || this.context?.gateway !== gateway) {
            return;
          }
          const sourceEpochChanged =
            nextSnapshot.client !== this.gatewayClient ||
            (nextSnapshot.phase === "connected") !== this.gatewayConnected ||
            nextSnapshot.hello !== this.gatewayHello;
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
      sessionKey = await resolveSkillWorkshopRevisionSessionKey(
        scope.state,
        scope.context,
        proposal,
        proposalAgentId,
        () => this.isCurrentSourceScope(scope),
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
      throw new Error(scope.sessions.state.error ?? "Could not prepare a Skill Workshop thread.");
    }
    const owner = scope.gateway.snapshot.hello;
    if (!owner) {
      return;
    }
    const handoff = {
      sessionKey,
      instructions,
      owner,
      proposalId: proposal.key,
      proposalAgentId: normalizeAgentId(proposal.origin?.agentId ?? proposalAgentId),
    };
    try {
      scope.revision.prepare(handoff);
    } catch (error) {
      if (!this.isCurrentSourceScope(scope)) {
        return;
      }
      throw error;
    }
    if (!this.isCurrentSourceScope(scope)) {
      scope.revision.clear(handoff);
      return;
    }
    scope.navigate(
      "chat",
      sessionNavigationTarget({ context: scope.context, face: "chat", sessionKey }).options,
    );
  };

  private readonly handleEvaluation = (proposalId: string) => {
    const scope = this.captureSourceScope();
    if (!scope) {
      return;
    }
    void runSkillWorkshopEvaluation(scope.state, scope.context, proposalId, () =>
      this.isCurrentSourceScope(scope),
    ).finally(this.requestPageUpdate);
  };

  private readonly handleRevisionSubmit = (proposalId: string) => {
    const scope = this.captureSourceScope();
    const sendRevisionRequest = this.onRevisionRequest ?? this.handleRevisionRequest;
    if (!scope) {
      return;
    }
    void requestSkillWorkshopRevision(
      scope.state,
      scope.context,
      proposalId,
      sendRevisionRequest,
      () => this.isCurrentSourceScope(scope),
    ).finally(this.requestPageUpdate);
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
    this.operationEpoch += 1;
    this.selfLearningBusy = false;
    this.selfLearningError = null;
    void this.proposalsTask.run([null, null, null, false]);
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
    this.gatewayHello = snapshot.hello;
    this.gatewayConnected = snapshot.phase === "connected";
    if (sourceEpochChanged) {
      this.resetSourceState();
    }
    if (
      snapshot.phase === "connected" &&
      (sourceEpochChanged || !this.state?.skillWorkshopLoaded)
    ) {
      this.loadProposals(sourceEpochChanged);
    }
  }

  private captureSourceScope(): SkillWorkshopSourceScope | null {
    return captureSkillWorkshopSourceScope({
      state: this.state,
      context: this.context,
      epoch: this.operationEpoch,
    });
  }

  private isCurrentSourceScope(scope: SkillWorkshopSourceScope): boolean {
    return isCurrentSkillWorkshopSourceScope(scope, {
      state: this.state,
      context: this.context,
      epoch: this.operationEpoch,
    });
  }

  private loadProposals(force: boolean) {
    const state = this.state;
    const context = this.context;
    if (!state || !context || context.gateway.snapshot.phase !== "connected") {
      return;
    }
    void this.proposalsTask.run([context, state, context.agentSelection.state.selectedId, force]);
  }

  private readonly handleHistoryScan = () => {
    if (
      !canCallWorkshopAdminMethod(this.context?.gateway?.snapshot, "skills.proposals.historyScan")
    ) {
      return;
    }
    const scope = this.captureSourceScope();
    if (!scope) {
      return;
    }
    void runSkillWorkshopPageHistoryScan({
      state: scope.state,
      context: scope.context,
      isCurrent: () => this.isCurrentSourceScope(scope),
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
    if (!canCallWorkshopAdminMethod(this.context?.gateway?.snapshot, "config.patch")) {
      return;
    }
    const scope = this.captureSourceScope();
    const runtimeConfig = scope?.context.runtimeConfig;
    if (!scope || !runtimeConfig || this.selfLearningBusy) {
      return;
    }
    this.selfLearningBusy = true;
    this.selfLearningError = null;
    this.requestPageUpdate();
    try {
      const error = await setSelfLearningEnabled(runtimeConfig, enabled, () =>
        this.isCurrentSourceScope(scope),
      );
      if (this.isCurrentSourceScope(scope)) {
        this.selfLearningError = error;
      }
    } finally {
      if (this.isCurrentSourceScope(scope)) {
        this.selfLearningBusy = false;
        this.requestPageUpdate();
      }
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
            onEvaluate: this.handleEvaluation,
            onRevisionSubmit: this.handleRevisionSubmit,
            selfLearning: resolveSelfLearning(
              this.context.runtimeConfig,
              this.selfLearningBusy,
              this.selfLearningError,
              canCallWorkshopAdminMethod(this.context.gateway.snapshot, "config.patch"),
            ),
            onSelfLearningToggle: this.handleSelfLearningToggle,
            onHistoryScan: this.handleHistoryScan,
            onRetry: () => this.loadProposals(true),
          },
          this.requestPageUpdate,
        )
      : nothing;
  }
}

if (!customElements.get("openclaw-skill-workshop-page")) {
  customElements.define("openclaw-skill-workshop-page", SkillWorkshopPage);
}
