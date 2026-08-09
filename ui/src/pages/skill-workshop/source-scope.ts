import type { ApplicationContext } from "../../app/context.ts";
import type { SkillWorkshopContext, SkillWorkshopState } from "./proposals.ts";

export type SkillWorkshopPageContext = ApplicationContext & SkillWorkshopContext;

export type SkillWorkshopSourceScope = {
  state: SkillWorkshopState;
  context: SkillWorkshopPageContext;
  epoch: number;
  gateway: SkillWorkshopPageContext["gateway"];
  agentSelection: SkillWorkshopPageContext["agentSelection"];
  sessions: SkillWorkshopPageContext["sessions"];
  revision: SkillWorkshopPageContext["skillWorkshopRevision"];
  navigate: SkillWorkshopPageContext["navigate"];
};

export function captureSkillWorkshopSourceScope(params: {
  state: SkillWorkshopState | null | undefined;
  context: SkillWorkshopPageContext | null | undefined;
  epoch: number;
}): SkillWorkshopSourceScope | null {
  const { state, context } = params;
  return state && context
    ? {
        state,
        context,
        epoch: params.epoch,
        gateway: context.gateway,
        agentSelection: context.agentSelection,
        sessions: context.sessions,
        revision: context.skillWorkshopRevision,
        navigate: context.navigate,
      }
    : null;
}

export function isCurrentSkillWorkshopSourceScope(
  scope: SkillWorkshopSourceScope,
  current: {
    state: SkillWorkshopState | null | undefined;
    context: SkillWorkshopPageContext | null | undefined;
    epoch: number;
  },
): boolean {
  const context = current.context;
  return (
    current.state === scope.state &&
    context === scope.context &&
    current.epoch === scope.epoch &&
    context?.gateway === scope.gateway &&
    context.agentSelection === scope.agentSelection &&
    context.sessions === scope.sessions &&
    context.skillWorkshopRevision === scope.revision &&
    context.navigate === scope.navigate
  );
}
