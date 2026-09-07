import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  selectedGitHubPublisher,
  type GitHubPublicationView,
} from "../../../lib/sessions/github-publication-controller.ts";
import { generateUUID } from "../../../lib/uuid.ts";

function sourceLabel(source: string): string {
  return t(
    source === "personal"
      ? "githubPublication.personal"
      : source === "agent-override"
        ? "githubPublication.agent"
        : "githubPublication.system",
  );
}

export function renderGitHubPublicationAction(publication: GitHubPublicationView) {
  if (publication.result?.status === "published") {
    return html`<a
        class="chat-pr__create"
        href=${publication.result.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        ${t("chat.pullRequests.openPublishedPr")}
      </a>
      ${renderPublicationButton(publication)}`;
  }
  if (publication.result || publication.locked) {
    return renderPublicationButton(publication);
  }
  return html`
    ${renderPublicationButton(publication)}
    <button
      class="btn btn--ghost btn--icon chat-icon-btn"
      type="button"
      aria-label=${t("githubPublication.account")}
      aria-haspopup="dialog"
      aria-expanded="false"
    >
      ${icons.chevronDown}
    </button>
    <wa-popover
      ${ref(bindPublicationPopover)}
      style="--max-width: min(320px, calc(100vw - 16px))"
      placement="top-end"
      @wa-show=${syncPublicationExpanded}
      @wa-hide=${syncPublicationExpanded}
    >
      ${renderPublicationAccounts(publication)}
    </wa-popover>
  `;
}

function bindPublicationPopover(element: Element | undefined) {
  const trigger = element?.previousElementSibling;
  if (element instanceof WaPopover && trigger instanceof HTMLButtonElement) {
    trigger.id ||= `github-publisher-${generateUUID()}`;
    element.id ||= `${trigger.id}-popover`;
    element.for = trigger.id;
    trigger.setAttribute("aria-controls", element.id);
  }
}

function syncPublicationExpanded(event: Event) {
  const popover = event.currentTarget;
  if (popover instanceof WaPopover) {
    popover.anchor?.setAttribute("aria-expanded", String(popover.open));
  }
}

function renderPublicationButton(publication: GitHubPublicationView) {
  const { result, selection, busy } = publication;
  let action: { click: (() => void) | undefined; label: string; disabled: boolean };
  if (result?.status === "failed" || result?.status === "published") {
    action = {
      click: publication.onNewAction,
      label: t(publication.canWrite ? "githubPublication.newAction" : "common.dismiss"),
      disabled: busy,
    };
  } else if (result?.status === "needs_confirmation") {
    action = {
      click: publication.onConfirm,
      label: t("githubPublication.confirm"),
      disabled: busy || !publication.personalReady,
    };
  } else if (result?.status === "publishing" || result?.status === "requested") {
    action = {
      click:
        result.publisher?.source === "personal" ? publication.onRefresh : publication.onPublish,
      label: busy ? t("chat.pullRequests.publishing") : t("githubPublication.check"),
      disabled: busy,
    };
  } else {
    action = {
      click: publication.onPublish,
      disabled:
        busy || !selection || (selection.source === "personal" && !publication.personalReady),
      label: busy
        ? t("chat.pullRequests.publishing")
        : publication.locked
          ? t("chat.pullRequests.retryPublication")
          : t("chat.pullRequests.publishPr"),
    };
  }
  // Accepted shared requests retain their status button even when no replay callback is available.
  return action.click || result?.status === "publishing" || result?.status === "requested"
    ? html`<button
        class="chat-pr__create"
        type="button"
        ?disabled=${action.disabled}
        @click=${action.click}
      >
        ${action.label}
      </button>`
    : nothing;
}

function renderPublicationAccount(publication: GitHubPublicationView) {
  const { selection, result } = publication;
  const publisher = result ? result.publisher : selectedGitHubPublisher(selection);
  return publisher
    ? html`<span data-publication-account>
        ${t("githubPublication.publishAs", { account: publisher.login })} ·
        ${sourceLabel(publisher.source)}
      </span>`
    : nothing;
}

function renderPublicationAccounts(publication: GitHubPublicationView) {
  const { options, selection, result, busy, locked } = publication;
  const personal = options?.personal;
  const personalAccount =
    personal?.state === "connected" && personal.generation ? personal.account : null;
  const canChoose =
    publication.onSelect && options && (!selection || (options.shared && personalAccount));
  return html`<div class="stack muted">
    ${renderPublicationAccount(publication)}
    ${
      canChoose
        ? html`<label>
            <span class="sr-only">${t("githubPublication.account")}</span>
            <select
              class="settings-select"
              aria-label=${t("githubPublication.account")}
              .value=${selection?.source ?? ""}
              ?disabled=${busy || locked}
              @change=${(event: Event) => {
                if (!(event.currentTarget instanceof HTMLSelectElement)) {
                  return;
                }
                const source = event.currentTarget.value;
                if (source === "shared" || source === "personal") {
                  publication.onSelect?.(source);
                }
              }}
            >
              ${
                !selection
                  ? html`<option value="" disabled>${t("githubPublication.choose")}</option>`
                  : nothing
              }
              ${
                options.shared
                  ? html`<option value="shared">
                      ${sourceLabel(options.shared.source)} · @${options.shared.login}
                    </option>`
                  : nothing
              }
              ${
                personalAccount
                  ? html`<option value="personal">
                      ${t("githubPublication.personal")} · @${personalAccount.login}
                    </option>`
                  : nothing
              }
            </select>
          </label>`
        : nothing
    }
    ${
      !publication.personalReady
        ? html`<span>${t("githubPublication.personalWorkspace")}</span>`
        : nothing
    }
    ${
      !result && options
        ? html`<span>${t("githubPublication.scopeHelp")}</span> ${
              !personalAccount
                ? html`<span
                    >${t(
                      personal === null
                        ? "githubPublication.unidentified"
                        : "githubPublication.connectHelp",
                    )}</span
                  >`
                : nothing
            }`
        : nothing
    }
    ${!options && !busy ? renderPublicationRefresh(publication) : nothing}
  </div>`;
}

function renderPublicationRefresh(publication: GitHubPublicationView) {
  return html`<button class="btn btn--sm" type="button" @click=${publication.onRefresh}>
    ${t("githubPublication.refresh")}
  </button>`;
}

export function renderGitHubPublicationDetails(publication: GitHubPublicationView) {
  const { selection, result, confirmation, busy, locked, error } = publication;
  const personalUnavailable = selection?.source === "personal" && !publication.personalReady;
  if (!result && !confirmation && !error && !locked && !personalUnavailable) {
    return nothing;
  }
  return html`<div class="chat-pr__publication-outcome" data-state=${result?.status ?? "selection"}>
    ${renderPublicationAccount(publication)}
    ${
      result && result.status !== "published"
        ? html`<span role="status">${result.message}</span>`
        : nothing
    }
    ${result?.status === "failed" ? html`<span>${result.nextAction}</span>` : nothing}
    ${error ? html`<span role="alert">${error}</span>` : nothing}
    ${locked && !result && !busy ? html`<span>${t("githubPublication.unknown")}</span>` : nothing}
    ${
      confirmation
        ? html`<div>
            <div>
              ${t("githubPublication.target", {
                repository: confirmation.repository,
                base: confirmation.baseBranch,
              })}
            </div>
            <div>
              ${t("githubPublication.pushTarget", {
                repository: confirmation.pushRepository,
                branch: confirmation.branch,
              })}
            </div>
            <details>
              <summary>${t("githubPublication.snapshot")}</summary>
              <div>
                ${t("githubPublication.head")}: <code>${confirmation.sourceHeadCommit}</code>
              </div>
              <div>
                ${t("githubPublication.index")}: <code>${confirmation.sourceIndexTree}</code>
              </div>
              <div>
                ${t("githubPublication.workspace")}: <code>${confirmation.workspaceTree}</code>
              </div>
            </details>
          </div>`
        : nothing
    }
    ${
      result?.effect
        ? html`<span
            >${t(
              result.effect.status === "dispatched"
                ? "githubPublication.dispatched"
                : "githubPublication.observed",
              {
                kind: t(
                  result.effect.kind === "push"
                    ? "githubPublication.effectPush"
                    : "githubPublication.effectPullRequest",
                ),
              },
            )}
            ${result.effect.headCommit ? html`<code>${result.effect.headCommit}</code>` : nothing}
            ${
              result.effect.url
                ? html`<a href=${result.effect.url} target="_blank" rel="noopener noreferrer"
                    >${t("githubPublication.effectLink")}</a
                  >`
                : nothing
            }
          </span>`
        : nothing
    }
    ${
      personalUnavailable ? html`<span>${t("githubPublication.personalWorkspace")}</span>` : nothing
    }
    ${
      !busy && (error || (result && !publication.onConfirm && result.status !== "published"))
        ? renderPublicationRefresh(publication)
        : nothing
    }
  </div>`;
}
