import { html } from "lit";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import {
  filterSkillWorkshopProposals,
  type SkillWorkshopMode,
} from "../../lib/skill-workshop/index.ts";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { canCallWorkshopAdminMethod, resolveWorkshopAccess } from "./access.ts";
import { renderSkillWorkshopHeaderControls, setSkillWorkshopMode } from "./header-controls.ts";
import type { SkillWorkshopRenderContext } from "./page-types.ts";
import { selectPluginsHubTab } from "./plugins-hub-navigation.ts";
import {
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
  const selectMode = (mode: SkillWorkshopMode) => {
    state.skillWorkshopQuery = "";
    state.skillWorkshopFilePreviewKey = null;
    setSkillWorkshopMode(state, mode, requestUpdate);
    if (mode === "skills") {
      onRetry();
    } else {
      const proposal = filterSkillWorkshopProposals(state.skillWorkshopProposals, "")[0];
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
          const visibleProposals = filterSkillWorkshopProposals(
            state.skillWorkshopProposals,
            state.skillWorkshopQuery,
          );
          const isSelectedProposal = (proposal: (typeof visibleProposals)[number]) =>
            proposal.key === state.skillWorkshopSelectedKey;
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
              installedSelection: state.skillWorkshopInstalledSkills.find(
                (skill) => skill.name === state.skillWorkshopInstalledName,
              )?.read ?? { status: "idle" },
              onSelectInstalled: selectInstalled,
              onRetryInstalled: () => {
                const name = state.skillWorkshopInstalledName;
                if (name) {
                  void selectSkillWorkshopInstalledSkill(state, context, name, {
                    force: true,
                  }).finally(requestUpdate);
                  requestUpdate();
                }
              },
              selectedKey: state.skillWorkshopSelectedKey,
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
              onRetry,
              onQueryChange: (query) => {
                state.skillWorkshopQuery = query;
                requestUpdate();
                if (state.skillWorkshopMode === "suggestions") {
                  selectVisibleFallback(
                    filterSkillWorkshopProposals(state.skillWorkshopProposals, query),
                  );
                }
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
