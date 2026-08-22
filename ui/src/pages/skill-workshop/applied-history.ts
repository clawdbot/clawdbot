import { html } from "lit";
import { until } from "lit/directives/until.js";
import { t } from "../../i18n/index.ts";
import {
  filterSkillWorkshopAppliedSkills,
  type SkillWorkshopAppliedSkill,
  type SkillWorkshopProposal,
} from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

type AppliedHistoryRuntime = typeof import("./applied-history.runtime.ts");

const MAX_APPLIED_DIFF_INPUT_CHARS = 120_000;

let appliedHistoryRuntime: AppliedHistoryRuntime | undefined;
let appliedHistoryLoad: Promise<AppliedHistoryRuntime> | undefined;

// Diff computation and its markup stay behind this one dynamic import so the
// startup bundle never carries them; both lazy entries share the same load.
function loadAppliedHistoryRuntime(): Promise<AppliedHistoryRuntime> {
  return (appliedHistoryLoad ??= import("./applied-history.runtime.ts").then((runtime) => {
    appliedHistoryRuntime = runtime;
    return runtime;
  }));
}

function pendingRuntime() {
  return html`<p class="sw-muted" aria-busy="true">${t("common.loading")}</p>`;
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

/**
 * What the body card should show for a revision. `previousUnavailable` keeps
 * the full body but says so, because a predecessor inspect can fail and a
 * silent full body would read as "nothing changed".
 */
export type SkillWorkshopBodyView =
  | { kind: "full" }
  | { kind: "loadingPrevious" }
  | { kind: "previousUnavailable" }
  | { kind: "tooLarge" }
  | { kind: "diff"; previous: SkillWorkshopProposal };

export function resolveAppliedBodyView(
  props: SkillWorkshopProps,
  proposal: SkillWorkshopProposal,
  previous: SkillWorkshopProposal | null,
): SkillWorkshopBodyView {
  if (!previous || props.appliedDiffMode === "full") {
    return { kind: "full" };
  }
  if (previous.bodyLoaded) {
    if (previous.body.length + proposal.body.length > MAX_APPLIED_DIFF_INPUT_CHARS) {
      return { kind: "tooLarge" };
    }
    return { kind: "diff", previous };
  }
  return props.inspectingKey === previous.key
    ? { kind: "loadingPrevious" }
    : { kind: "previousUnavailable" };
}

export function renderLazyAppliedHistory(
  props: SkillWorkshopProps,
  skill: SkillWorkshopAppliedSkill,
) {
  if (appliedHistoryRuntime) {
    return appliedHistoryRuntime.renderAppliedHistory(props, skill);
  }
  return until(
    loadAppliedHistoryRuntime().then((runtime) => runtime.renderAppliedHistory(props, skill)),
    pendingRuntime(),
  );
}

export function renderLazyAppliedRevisionDiff(previousBody: string, body: string) {
  if (appliedHistoryRuntime) {
    return appliedHistoryRuntime.renderAppliedRevisionDiff(previousBody, body);
  }
  return until(
    loadAppliedHistoryRuntime().then((runtime) =>
      runtime.renderAppliedRevisionDiff(previousBody, body),
    ),
    pendingRuntime(),
  );
}
