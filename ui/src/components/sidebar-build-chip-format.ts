import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, type TemplateResult } from "lit";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/format.ts";
import { icons } from "./icons.ts";

const BRANCH_DISPLAY_LENGTH = 14;
const COPY_FEEDBACK_MS = 1_500;

async function copyBuildCommit(event: Event, commit: string, idleLabel: string) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const copied = await copyToClipboard(commit);
  button.dataset.copied = copied ? "1" : "0";
  button.setAttribute("aria-label", t(copied ? "aboutPage.copiedCommit" : "common.copyFailed"));
  window.setTimeout(() => {
    if (!button.isConnected) {
      return;
    }
    delete button.dataset.copied;
    button.setAttribute("aria-label", idleLabel);
  }, COPY_FEEDBACK_MS);
}

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

function formatIdentityMenuBuildLabel(info: ControlUiBuildInfo): string | null {
  const compactBuild = formatBuildChipText(info);
  if (!compactBuild) {
    return null;
  }
  return info.branch && info.branch !== "main" ? compactBuild : `git@${compactBuild}`;
}

function formatNonReleaseGitIdentity(info: ControlUiBuildInfo): string | null {
  if (info.release) {
    return null;
  }
  return formatIdentityMenuBuildLabel(info);
}

export function formatSidebarBuildSubtitle(info: ControlUiBuildInfo): string | null {
  const gitIdentity = formatNonReleaseGitIdentity(info);
  if (!gitIdentity) {
    return null;
  }
  const commitAt = info.commitAt ? Date.parse(info.commitAt) : Number.NaN;
  return Number.isFinite(commitAt)
    ? `${gitIdentity} · ${formatRelativeTimestamp(commitAt)}`
    : gitIdentity;
}

export function formatSettingsBuildLabel(
  info: ControlUiBuildInfo,
  gatewayVersion: string | null,
): string | null {
  const version = info.version ?? gatewayVersion;
  const gitIdentity = formatNonReleaseGitIdentity(info);
  if (!gitIdentity) {
    return version;
  }
  return [version, gitIdentity].filter((value): value is string => Boolean(value)).join(" · ");
}

function formatBuildCardDetails(info: ControlUiBuildInfo, gatewayVersion: string | null) {
  const builtAtMs = info.builtAt ? Date.parse(info.builtAt) : Number.NaN;
  return {
    summary: info.version ? `v${info.version}` : null,
    commit: info.commit?.slice(0, 12) ?? null,
    builtAt: Number.isFinite(builtAtMs)
      ? `${formatDateTimeMs(builtAtMs, {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        })} UTC`
      : null,
    gatewayVersion,
  };
}

export function renderSidebarServerDetails(
  info: ControlUiBuildInfo,
  gatewayVersion: string | null,
): TemplateResult {
  const details = formatBuildCardDetails(info, gatewayVersion);
  const commit = details.commit;
  const unavailable = t("aboutPage.unavailable");
  const copyLabel = t("aboutPage.copyCommit");
  return html`
    <div class="sidebar-hover-card__server-details">
      <div class="sidebar-hover-card__summary">${details.summary || unavailable}</div>
      <dl class="sidebar-hover-card__metadata">
        <div class="sidebar-hover-card__metadata-row">
          <dt>${t("aboutPage.commit")}</dt>
          <dd class="sidebar-hover-card__metadata-value--mono sidebar-build-hover-card__commit">
            <span>${commit ?? unavailable}</span>
            ${
              commit
                ? html`<button
                    type="button"
                    class="sidebar-build-hover-card__copy"
                    aria-label=${copyLabel}
                    @click=${(event: Event) => void copyBuildCommit(event, commit, copyLabel)}
                  >
                    <span class="sidebar-build-hover-card__copy-idle" aria-hidden="true"
                      >${icons.copy}</span
                    >
                    <span class="sidebar-build-hover-card__copy-done" aria-hidden="true"
                      >${icons.check}</span
                    >
                  </button>`
                : null
            }
          </dd>
        </div>
        <div class="sidebar-hover-card__metadata-row">
          <dt>${t("aboutPage.built")}</dt>
          <dd>${details.builtAt ?? unavailable}</dd>
        </div>
        <div class="sidebar-hover-card__metadata-row">
          <dt>${t("aboutPage.gateway")}</dt>
          <dd>
            ${
              details.gatewayVersion
                ? html`<span
                      class="sidebar-build-hover-card__gateway-state"
                      aria-hidden="true"
                    ></span
                    ><span class="sr-only">${t("common.connected")}</span>`
                : null
            }
            ${details.gatewayVersion ?? unavailable}
          </dd>
        </div>
      </dl>
    </div>
  `;
}
