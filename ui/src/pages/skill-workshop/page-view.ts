import { html } from "lit";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import {
  filterSkillWorkshopProposals,
  filterWorkshopSection,
  type SkillWorkshopAppliedDiffMode,
  type SkillWorkshopMode,
} from "../../lib/skill-workshop/index.ts";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { canCallWorkshopAdminMethod, resolveWorkshopAccess } from "./access.ts";
import { renderSkillWorkshopHeaderControls, setSkillWorkshopMode } from "./header-controls.ts";
import type { SkillWorkshopRenderContext } from "./page-types.ts";
import { selectPluginsHubTab } from "./plugins-hub-navigation.ts";
import {
  countSkillWorkshopProposals,
  runSkillWorkshopLifecycleAction,
  selectSkillWorkshopInstalledSkill,
  selectSkillWorkshopProposal,
  type SkillWorkshopState,
} from "./proposals.ts";
import { renderSkillWorkshop } from "./view.ts";

export function renderSkillWorkshopPage(
  state: SkillWorkshopState,
  renderContext: SkillWorkshopRenderContext,
  requestUpdate: () => void,
) {
  const {
    context,
    revisionRecoveryActive,
    workshopAgentName,
    onEvaluate,
    onRevisionSubmit,
    selfLearning,
    onSelfLearningToggle,
    onHistoryScan,
    onRetry,
  } = renderContext;
  const access = resolveWorkshopAccess(context.gateway.snapshot);
  const selectInstalled = (name: string) => {
    void selectSkillWorkshopInstalledSkill(state, context, name).finally(requestUpdate);
    requestUpdate();
  };
  const selectMode = (mode: SkillWorkshopMode, query = "") => {
    state.skillWorkshopStatusFilter = mode === "suggestions" ? "pending" : "all";
    state.skillWorkshopQuery = query;
    state.skillWorkshopFilePreviewKey = null;
    setSkillWorkshopMode(state, mode, requestUpdate);
    if (mode === "skills") {
      const current = state.skillWorkshopInstalledSelection;
      const skill =
        state.skillWorkshopInstalledSkills.find(
          (candidate) => current.status !== "idle" && candidate.name === current.name,
        ) ?? state.skillWorkshopInstalledSkills[0];
      if (skill) {
        selectInstalled(skill.name);
      }
    } else {
      const proposal = filterSkillWorkshopProposals(
        filterWorkshopSection(state.skillWorkshopProposals, mode),
        state.skillWorkshopStatusFilter,
        query,
      )[0];
      if (proposal) {
        void selectSkillWorkshopProposal(state, context, proposal.key).finally(requestUpdate);
      }
    }
  };

  return html`
    <section class="content--skill-workshop">
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
          ${renderAgentScopeControl({
            agents: context.agents.state.agentsList?.agents ?? [],
            selection: context.agentSelection,
            selectedId: state.skillWorkshopAgentId,
            allowAll: false,
          })}
          ${renderSkillWorkshopHeaderControls(state, { ...renderContext, onModeChange: selectMode })}
        </div>
        ${(() => {
          const sectionProposals = filterWorkshopSection(
            state.skillWorkshopProposals,
            state.skillWorkshopMode,
          );
          const visibleProposals = filterSkillWorkshopProposals(
            sectionProposals,
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
              installedSkills: state.skillWorkshopInstalledSkills,
              installedSelection: state.skillWorkshopInstalledSelection,
              onSelectInstalled: selectInstalled,
              onRetryInstalled: () => {
                const selection = state.skillWorkshopInstalledSelection;
                if (selection.status !== "idle") {
                  selectInstalled(selection.name);
                }
              },
              onShowHistory: (skillKey) => selectMode("history", skillKey),
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
              revisionRecoveryActive,
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
                  filterSkillWorkshopProposals(sectionProposals, status, state.skillWorkshopQuery),
                );
              },
              onQueryChange: (query) => {
                state.skillWorkshopQuery = query;
                requestUpdate();
                selectVisibleFallback(
                  filterSkillWorkshopProposals(
                    sectionProposals,
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
              onModeChange: selectMode,
              onSelect: selectProposal,
              onAppliedDiffModeChange: (mode: SkillWorkshopAppliedDiffMode) => {
                state.skillWorkshopAppliedDiffMode = mode;
                requestUpdate();
              },
              onPrev: () => selectRelativeProposal(-1),
              onNext: () => selectRelativeProposal(1),
              onApply: (decision) => {
                if (
                  !canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.proposals.apply")
                ) {
                  return;
                }
                void runSkillWorkshopLifecycleAction(state, context, "apply", decision).finally(
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
              onReject: (decision) => {
                if (
                  !canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.proposals.reject")
                ) {
                  return;
                }
                void runSkillWorkshopLifecycleAction(state, context, "reject", decision).finally(
                  requestUpdate,
                );
                requestUpdate();
              },
              onRevisionDraftChange: (draft) => {
                state.skillWorkshopRevisionDraft = draft;
                requestUpdate();
              },
              onRevisionCancel: () => {
                if (revisionRecoveryActive) {
                  return;
                }
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
