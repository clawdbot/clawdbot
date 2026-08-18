import { html } from "lit";
import { until } from "lit/directives/until.js";
import { t } from "../../i18n/index.ts";
import {
  filterSkillWorkshopAppliedSkills,
  type SkillWorkshopAppliedSkill,
  type SkillWorkshopProposal,
} from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

type AppliedHistoryRenderer = typeof import("./applied-history.runtime.ts").renderAppliedHistory;

let appliedHistoryRenderer: AppliedHistoryRenderer | undefined;
let appliedHistoryRuntime: Promise<AppliedHistoryRenderer> | undefined;

function loadAppliedHistoryRenderer(): Promise<AppliedHistoryRenderer> {
  return (appliedHistoryRuntime ??= import("./applied-history.runtime.ts").then((runtime) => {
    appliedHistoryRenderer = runtime.renderAppliedHistory;
    return appliedHistoryRenderer;
  }));
}

export function resolveAppliedHistory(
  proposals: SkillWorkshopProposal[],
  query: string,
  selectedKey: string | null,
) {
  const skills = filterSkillWorkshopAppliedSkills(proposals, query);
  const selectedSkill =
    skills.find((skill) => skill.revisions.some(({ proposal }) => proposal.key === selectedKey)) ??
    skills[0];
  const selectedProposal =
    selectedSkill?.revisions.find(({ proposal }) => proposal.key === selectedKey)?.proposal ??
    selectedSkill?.latest;
  return { skills, selectedSkill, selectedProposal };
}

export function renderLazyAppliedHistory(
  props: SkillWorkshopProps,
  skill: SkillWorkshopAppliedSkill,
) {
  if (appliedHistoryRenderer) {
    return appliedHistoryRenderer(props, skill);
  }
  return until(
    loadAppliedHistoryRenderer().then((renderer) => renderer(props, skill)),
    html`<p class="sw-muted" aria-busy="true">${t("common.loading")}</p>`,
  );
}
