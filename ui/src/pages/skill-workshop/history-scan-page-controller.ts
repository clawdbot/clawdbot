import { loadSkillWorkshopHistoryScanStatus, runSkillWorkshopHistoryScan } from "./history-scan.ts";
import {
  loadSkillWorkshopProposals,
  resolveSkillWorkshopAgentId,
  type SkillWorkshopContext,
  type SkillWorkshopState,
} from "./proposals.ts";

export function loadSkillWorkshopPageData(params: {
  context: SkillWorkshopContext;
  force: boolean;
  state: SkillWorkshopState;
}): Promise<void> {
  const agentId = resolveSkillWorkshopAgentId(params.context);
  return Promise.all([
    loadSkillWorkshopProposals(params.state, params.context, { force: params.force }),
    loadSkillWorkshopHistoryScanStatus({
      agentId,
      gateway: params.context.gateway,
      state: params.state.skillWorkshopHistoryScan,
      force: params.force,
    }),
  ]).then(() => undefined);
}

export async function runSkillWorkshopPageHistoryScan(params: {
  context: SkillWorkshopContext;
  current: () => { context: SkillWorkshopContext; state: SkillWorkshopState } | undefined;
  state: SkillWorkshopState;
}): Promise<void> {
  const agentId = resolveSkillWorkshopAgentId(params.context);
  const historyState = params.state.skillWorkshopHistoryScan;
  await runSkillWorkshopHistoryScan({
    agentId,
    gateway: params.context.gateway,
    state: historyState,
  });
  const current = params.current();
  if (!current || resolveSkillWorkshopAgentId(current.context) !== agentId) {
    return;
  }
  const refreshes: Promise<void>[] = [
    loadSkillWorkshopProposals(current.state, current.context, { force: true }),
  ];
  if (current.state.skillWorkshopHistoryScan !== historyState) {
    refreshes.push(
      loadSkillWorkshopHistoryScanStatus({
        agentId,
        gateway: current.context.gateway,
        state: current.state.skillWorkshopHistoryScan,
        force: true,
      }),
    );
  }
  await Promise.all(refreshes);
}
