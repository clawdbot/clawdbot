// Chat UI chips for pull requests detected on the session's working branch.
import { html, nothing } from "lit";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../../src/gateway/control-ui-contract.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";

const DISMISSED_STORAGE_KEY = "openclaw.chat.dismissedPullRequests";
// Bounds localStorage growth: dismissals for the oldest sessions fall off
// once this many sessions have dismissed chips.
const DISMISSED_SESSION_LIMIT = 20;

export function chatPullRequestId(pullRequest: ControlUiSessionPullRequest): string {
  return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`.toLowerCase();
}

function readDismissedStore(storage: Storage): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(DISMISSED_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        store[key] = value.filter((id): id is string => typeof id === "string");
      }
    }
    return store;
  } catch {
    return {};
  }
}

export function listDismissedChatPullRequests(sessionKey: string): ReadonlySet<string> {
  const storage = getSafeLocalStorage();
  if (!storage || !sessionKey) {
    return new Set();
  }
  return new Set(readDismissedStore(storage)[sessionKey] ?? []);
}

export function dismissChatPullRequest(
  sessionKey: string,
  pullRequest: ControlUiSessionPullRequest,
): ReadonlySet<string> {
  const storage = getSafeLocalStorage();
  if (!storage || !sessionKey) {
    return new Set([chatPullRequestId(pullRequest)]);
  }
  const store = readDismissedStore(storage);
  const ids = new Set(store[sessionKey] ?? []);
  ids.add(chatPullRequestId(pullRequest));
  delete store[sessionKey];
  store[sessionKey] = [...ids];
  const staleSessions = Object.keys(store).slice(0, -DISMISSED_SESSION_LIMIT);
  for (const staleKey of staleSessions) {
    delete store[staleKey];
  }
  try {
    storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota or privacy-mode failures only cost re-showing dismissed chips.
  }
  return ids;
}

function stateLabel(state: ControlUiSessionPullRequest["state"]): string {
  switch (state) {
    case "merged":
      return t("chat.pullRequests.merged");
    case "draft":
      return t("chat.pullRequests.draft");
    case "closed":
      return t("chat.pullRequests.closed");
    default:
      return t("chat.pullRequests.open");
  }
}

function checksLabel(checks: NonNullable<ControlUiSessionPullRequest["checks"]>): string {
  switch (checks.state) {
    case "passing":
      return t("chat.pullRequests.checksPassing");
    case "failing":
      return t("chat.pullRequests.checksFailing");
    default:
      return t("chat.pullRequests.checksPending");
  }
}

function renderChecksRow(label: string, count: number, modifier: string) {
  if (count === 0) {
    return nothing;
  }
  return html`
    <div class="chat-pr__checks-row chat-pr__checks-row--${modifier}">
      <span class="chat-pr__checks-row-dot" aria-hidden="true"></span>
      <span class="chat-pr__checks-row-label">${label}</span>
      <span class="chat-pr__checks-row-count">${count}</span>
    </div>
  `;
}

function renderChecks(pullRequest: ControlUiSessionPullRequest) {
  const checks = pullRequest.checks;
  if (!checks) {
    return nothing;
  }
  const label = checksLabel(checks);
  return html`
    <details class="chat-pr__checks" data-checks=${checks.state}>
      <summary class="chat-pr__checks-pill" aria-label=${label} title=${label}>
        <span class="chat-pr__checks-dot" aria-hidden="true"></span>
        ${t("chat.pullRequests.checks")}
      </summary>
      <div
        class="chat-pr__checks-menu"
        role="group"
        aria-label=${t("chat.pullRequests.ciMonitoring")}
      >
        <div class="chat-pr__checks-menu-header">
          <span>${t("chat.pullRequests.ciMonitoring")}</span>
          <a
            href=${pullRequest.checksUrl ?? pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${t("chat.pullRequests.openChecks")}
          >
            ${icons.externalLink}
          </a>
        </div>
        ${renderChecksRow(t("chat.pullRequests.checksPassed"), checks.passed, "passed")}
        ${renderChecksRow(t("chat.pullRequests.checksFailed"), checks.failed, "failed")}
        ${renderChecksRow(t("chat.pullRequests.checksRunning"), checks.running, "running")}
        ${renderChecksRow(t("chat.pullRequests.checksSkipped"), checks.skipped, "skipped")}
      </div>
    </details>
  `;
}

const MAX_COLLAPSED_PULL_REQUESTS = 2;

// Matches GitHub's own diff-stat rendering ("+2,819") in the viewer's locale.
function formatDiffCount(value: number): string {
  return value.toLocaleString();
}

/**
 * The pre-PR "Create PR" row must not invite a duplicate PR, so live PRs
 * (even dismissed ones) hide it — decided on the undismissed PR list. The
 * gateway already omits branches with neither a creatable PR nor local
 * changed files.
 */
export function createPullRequestBranch(
  pullRequests: readonly ControlUiSessionPullRequest[],
  branch: ControlUiSessionBranch | undefined,
): ControlUiSessionBranch | undefined {
  if (!branch) {
    return undefined;
  }
  if (pullRequests.some((item) => item.state === "open" || item.state === "draft")) {
    return undefined;
  }
  return branch;
}

// Collapsed rows lead with live work; merged/closed history sits behind the
// "show more" toggle so a long landing streak never buries the active PR.
function visibleChatPullRequests(
  pullRequests: ControlUiSessionPullRequest[],
  expanded: boolean,
): { visible: ControlUiSessionPullRequest[]; hiddenCount: number } {
  const active = pullRequests.filter((item) => item.state === "open" || item.state === "draft");
  const settled = pullRequests.filter((item) => item.state !== "open" && item.state !== "draft");
  const ordered = [...active, ...settled];
  if (expanded || ordered.length <= MAX_COLLAPSED_PULL_REQUESTS) {
    return { visible: ordered, hiddenCount: 0 };
  }
  return {
    visible: ordered.slice(0, MAX_COLLAPSED_PULL_REQUESTS),
    hiddenCount: ordered.length - MAX_COLLAPSED_PULL_REQUESTS,
  };
}

function renderDiffStats(item: { additions?: number; deletions?: number }) {
  if (typeof item.additions !== "number" && typeof item.deletions !== "number") {
    return nothing;
  }
  return html`
    <span class="chat-pr__diff">
      <span class="chat-pr__additions">+${formatDiffCount(item.additions ?? 0)}</span>
      <span class="chat-pr__deletions">−${formatDiffCount(item.deletions ?? 0)}</span>
    </span>
  `;
}

function renderRateLimitWarning() {
  return html`
    <openclaw-tooltip content=${t("chat.pullRequests.rateLimited")}>
      <span class="chat-pr__warning" role="img" aria-label=${t("chat.pullRequests.rateLimited")}>
        ${icons.alertTriangle}
      </span>
    </openclaw-tooltip>
  `;
}

// Pre-PR state: the branch row mirrors the PR chips (repo, branch, diff
// stats, staleness warning) and offers GitHub's create-PR page. While the
// branch is unpushed the gateway omits createUrl — the row then just reports
// the session's local changed files. While rate limited, "no PR found" is
// unreliable, so the warning stays visible here.
function renderBranchRow(branch: ControlUiSessionBranch, rateLimited: boolean) {
  return html`
    <article class="chat-pr" data-state="branch">
      <span class="chat-pr__link chat-pr__link--static">
        <span class="chat-pr__icon" aria-hidden="true">${icons.gitBranch}</span>
        <span class="chat-pr__repo">${branch.repo}</span>
        <span class="chat-pr__branch">${branch.branch}</span>
      </span>
      <span class="chat-pr__meta">
        ${renderDiffStats(branch)} ${rateLimited ? renderRateLimitWarning() : nothing}
        ${branch.createUrl
          ? html`
              <a
                class="chat-pr__create"
                href=${branch.createUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label=${t("chat.pullRequests.createPrLabel", { branch: branch.branch })}
              >
                ${t("chat.pullRequests.createPr")}
              </a>
            `
          : nothing}
      </span>
    </article>
  `;
}

export function renderChatPullRequests(props: {
  pullRequests: ControlUiSessionPullRequest[];
  branch?: ControlUiSessionBranch;
  rateLimited: boolean;
  expanded: boolean;
  onExpand: () => void;
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
}) {
  if (props.pullRequests.length === 0 && !props.branch) {
    return nothing;
  }
  const { visible, hiddenCount } = visibleChatPullRequests(props.pullRequests, props.expanded);
  return html`
    <div class="chat-prs" aria-live="polite">
      ${props.branch ? renderBranchRow(props.branch, props.rateLimited) : nothing}
      ${visible.map((pullRequest) => {
        const merged = pullRequest.state === "merged";
        return html`
          <article class="chat-pr" data-state=${pullRequest.state}>
            <a
              class="chat-pr__link"
              href=${pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label=${t("chat.pullRequests.linkLabel", {
                number: String(pullRequest.number),
                title: pullRequest.title,
              })}
            >
              <span class="chat-pr__icon" aria-hidden="true">
                ${merged ? icons.gitMerge : icons.gitPullRequest}
              </span>
              <span class="chat-pr__number">#${pullRequest.number}</span>
              <span class="chat-pr__repo">${pullRequest.repo}</span>
              <span class="chat-pr__branch">${pullRequest.branch}</span>
            </a>
            <span class="chat-pr__meta">
              ${renderDiffStats(pullRequest)} ${renderChecks(pullRequest)}
              ${pullRequest.state === "open"
                ? nothing
                : html`<span class="chat-pr__state">${stateLabel(pullRequest.state)}</span>`}
              ${props.rateLimited && !merged ? renderRateLimitWarning() : nothing}
              <button
                class="chat-pr__dismiss"
                type="button"
                aria-label=${t("chat.pullRequests.dismiss", {
                  number: String(pullRequest.number),
                })}
                @click=${() => props.onDismiss(pullRequest)}
              >
                ${icons.x}
              </button>
            </span>
          </article>
        `;
      })}
      ${hiddenCount > 0
        ? html`
            <button class="chat-prs__more" type="button" @click=${props.onExpand}>
              ${t("chat.pullRequests.showMore", { count: String(hiddenCount) })}
            </button>
          `
        : nothing}
    </div>
  `;
}
