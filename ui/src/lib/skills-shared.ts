// Shared skill status rendering and classification helpers.
import { html, nothing } from "lit";
import type { SkillStatusEntry } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export function computeSkillMissing(skill: SkillStatusEntry): string[] {
  return [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
}

export function computeSkillReasons(skill: SkillStatusEntry): string[] {
  const reasons: string[] = [];
  if (skill.disabled) {
    reasons.push(t("skillStatus.disabled"));
  }
  if (skill.blockedByAllowlist) {
    reasons.push(t("skillStatus.blockedAllowlist"));
  }
  if (skill.blockedByAgentFilter) {
    reasons.push(t("skillStatus.blockedAgentFilter"));
  }
  return reasons;
}

export function isSkillAvailable(skill: SkillStatusEntry): boolean {
  return skill.eligible && !skill.blockedByAgentFilter;
}

export function renderSkillStatusChips(params: {
  skill: SkillStatusEntry;
  showBundledBadge?: boolean;
}) {
  const skill = params.skill;
  const available = isSkillAvailable(skill);
  const showBundledBadge = Boolean(params.showBundledBadge);
  return html`
    <div class="chip-row" style="margin-top: 6px;">
      <span class="chip">${skill.source}</span>
      ${showBundledBadge ? html` <span class="chip">${t("skillStatus.bundled")}</span> ` : nothing}
      <span class="chip ${available ? "chip-ok" : "chip-warn"}">
        ${available ? t("skillStatus.eligible") : t("skillStatus.blocked")}
      </span>
      ${skill.disabled
        ? html` <span class="chip chip-warn">${t("skillStatus.disabled")}</span> `
        : nothing}
    </div>
  `;
}
