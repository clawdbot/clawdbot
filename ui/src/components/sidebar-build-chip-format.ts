import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, type TemplateResult } from "lit";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { t } from "../i18n/index.ts";

const BRANCH_DISPLAY_LENGTH = 14;

function formatBranchPrefix(branch: string | null): string {
  if (!branch || branch === "main") {
    return "";
  }
  const displayBranch =
    branch.length > BRANCH_DISPLAY_LENGTH
      ? `${truncateUtf16Safe(branch, BRANCH_DISPLAY_LENGTH)}…`
      : branch;
  return `${displayBranch}@`;
}

export function formatBuildChipText(info: ControlUiBuildInfo): string | null {
  if (!info.commit) {
    return null;
  }
  const branch = formatBranchPrefix(info.branch);
  const commit = `${info.commit.slice(0, 7)}${info.dirty === true ? "*" : ""}`;
  return `${branch}${commit}`;
}

function formatBuildCardDetails(info: ControlUiBuildInfo, gatewayVersion: string | null) {
  return {
    summary: [
      info.version ? `v${info.version}` : null,
      info.branch,
      info.dirty === true ? "dirty" : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
    commit: info.commit?.slice(0, 12) ?? null,
    builtAt: info.builtAt,
    gatewayVersion,
  };
}

export function renderSidebarServerDetails(
  info: ControlUiBuildInfo,
  gatewayVersion: string | null,
): TemplateResult {
  const details = formatBuildCardDetails(info, gatewayVersion);
  const unavailable = t("aboutPage.unavailable");
  const rows = [
    { label: t("aboutPage.commit"), value: details.commit ?? unavailable, mono: true },
    { label: t("aboutPage.built"), value: details.builtAt ?? unavailable, mono: false },
    {
      label: t("aboutPage.gatewayVersion"),
      value: details.gatewayVersion ?? unavailable,
      mono: false,
    },
  ];
  return html`
    <div class="sidebar-hover-card__server-details">
      <div class="sidebar-hover-card__summary">${details.summary || unavailable}</div>
      <dl class="sidebar-hover-card__metadata">
        ${rows.map(
          (row) => html`
            <div class="sidebar-hover-card__metadata-row">
              <dt>${row.label}</dt>
              <dd class=${row.mono ? "sidebar-hover-card__metadata-value--mono" : ""}>
                ${row.value}
              </dd>
            </div>
          `,
        )}
      </dl>
    </div>
  `;
}
