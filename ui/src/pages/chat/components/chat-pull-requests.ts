// Chat UI chips for pull requests detected on the session's working branch.
import { html, nothing } from "lit";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
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
  switch (checks) {
    case "passing":
      return t("chat.pullRequests.checksPassing");
    case "failing":
      return t("chat.pullRequests.checksFailing");
    default:
      return t("chat.pullRequests.checksPending");
  }
}

function renderChecks(pullRequest: ControlUiSessionPullRequest) {
  if (!pullRequest.checks) {
    return nothing;
  }
  const label = checksLabel(pullRequest.checks);
  return html`
    <openclaw-tooltip content=${label}>
      <a
        class="chat-pr__checks"
        data-checks=${pullRequest.checks}
        href=${pullRequest.checksUrl ?? pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label=${label}
      >
        <span class="chat-pr__checks-dot" aria-hidden="true"></span>
        ${t("chat.pullRequests.checks")}
      </a>
    </openclaw-tooltip>
  `;
}

export function renderChatPullRequests(props: {
  pullRequests: ControlUiSessionPullRequest[];
  rateLimited: boolean;
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
}) {
  if (props.pullRequests.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-prs" aria-live="polite">
      ${props.pullRequests.map((pullRequest) => {
        const merged = pullRequest.state === "merged";
        const showDiff =
          typeof pullRequest.additions === "number" || typeof pullRequest.deletions === "number";
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
              ${showDiff
                ? html`
                    <span class="chat-pr__diff">
                      <span class="chat-pr__additions">+${pullRequest.additions ?? 0}</span>
                      <span class="chat-pr__deletions">−${pullRequest.deletions ?? 0}</span>
                    </span>
                  `
                : nothing}
              ${renderChecks(pullRequest)}
              ${pullRequest.state === "open"
                ? nothing
                : html`<span class="chat-pr__state">${stateLabel(pullRequest.state)}</span>`}
              ${props.rateLimited && !merged
                ? html`
                    <openclaw-tooltip content=${t("chat.pullRequests.rateLimited")}>
                      <span
                        class="chat-pr__warning"
                        role="img"
                        aria-label=${t("chat.pullRequests.rateLimited")}
                      >
                        ${icons.alertTriangle}
                      </span>
                    </openclaw-tooltip>
                  `
                : nothing}
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
    </div>
  `;
}
