import { initialState, Task } from "@lit/task";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, ReactiveElement, render, type TemplateResult } from "lit";
import type { ControlUiGitHubPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n, t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatUiError } from "../lib/format-error.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import "../styles/github-link-hovercard.css";
import {
  GITHUB_HOVERCARD_OPEN_DELAY_MS,
  githubLinkAnchorFromEvent,
  gitHubProfileUrl,
  parseGitHubLinkTarget,
  type GitHubLinkTarget,
} from "./github-link-target.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

type GitHubPreview = GitHubLinkTarget & ControlUiGitHubPreview;

type PreviewState = {
  label: string;
  tone: "danger" | "muted" | "open" | "purple";
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<ControlUiGitHubPreview>;
  signal: AbortSignal;
};

let nextHovercardId = 0;

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = readNonBlankString(record[key]);
  if (value === undefined) {
    throw new Error(`GitHub response omitted ${key}`);
  }
  return value;
}

function safeAvatarDataUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^data:image\/(?:gif|jpeg|png|webp);base64,/u.test(value)
    ? value
    : undefined;
}

/** Gateway data is untrusted here: keep only well-formed logins and inlined avatars. */
function parseCoAuthors(value: unknown): { login: string; avatarDataUrl?: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const login = readNonBlankString(entry.login);
    if (!login) {
      return [];
    }
    const avatarDataUrl = safeAvatarDataUrl(entry.avatarDataUrl);
    return [avatarDataUrl ? { login, avatarDataUrl } : { login }];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function parsePreviewResponse(target: GitHubLinkTarget, value: unknown): ControlUiGitHubPreview {
  if (!isRecord(value)) {
    throw new Error("GitHub response was not an object");
  }
  if (
    value.kind !== target.kind ||
    typeof value.owner !== "string" ||
    value.owner.toLowerCase() !== target.owner.toLowerCase() ||
    typeof value.repo !== "string" ||
    value.repo.toLowerCase() !== target.repo.toLowerCase() ||
    value.number !== target.number
  ) {
    throw new Error("GitHub response did not match the requested link");
  }
  return {
    additions: asFiniteNumber(value.additions),
    avatarDataUrl: safeAvatarDataUrl(value.avatarDataUrl),
    closedAt: readNonBlankString(value.closedAt),
    coAuthorCount: asFiniteNumber(value.coAuthorCount),
    coAuthors: parseCoAuthors(value.coAuthors),
    comments: asFiniteNumber(value.comments),
    createdAt: requiredString(value, "createdAt"),
    deletions: asFiniteNumber(value.deletions),
    draft: typeof value.draft === "boolean" ? value.draft : undefined,
    kind: target.kind,
    login: readNonBlankString(value.login) ?? "ghost",
    mergedAt: readNonBlankString(value.mergedAt),
    number: target.number,
    owner: target.owner,
    repo: target.repo,
    state: requiredString(value, "state"),
    stateReason: readNonBlankString(value.stateReason),
    title: requiredString(value, "title"),
    updatedAt: requiredString(value, "updatedAt"),
  };
}

function previewState(preview: GitHubPreview): PreviewState {
  if (preview.kind === "pull") {
    if (preview.mergedAt) {
      return { label: t("githubPreview.states.merged"), tone: "purple" };
    }
    if (preview.draft && preview.state === "open") {
      return { label: t("githubPreview.states.draft"), tone: "muted" };
    }
    return preview.state === "open"
      ? { label: t("githubPreview.states.open"), tone: "open" }
      : { label: t("githubPreview.states.closed"), tone: "danger" };
  }
  if (preview.state === "open") {
    return { label: t("githubPreview.states.open"), tone: "open" };
  }
  return preview.stateReason === "not_planned"
    ? { label: t("githubPreview.states.notPlanned"), tone: "muted" }
    : { label: t("githubPreview.states.closed"), tone: "purple" };
}

function renderAvatar(dataUrl: string | undefined) {
  return dataUrl
    ? html`<img
        class="github-link-hovercard__avatar"
        alt=""
        decoding="async"
        referrerpolicy="no-referrer"
        src=${dataUrl}
      />`
    : nothing;
}

function renderCoAuthors(preview: GitHubPreview) {
  const coAuthors = preview.coAuthors ?? [];
  const total = preview.coAuthorCount ?? coAuthors.length;
  if (coAuthors.length === 0) {
    return nothing;
  }
  // Counted from rendered faces, not fetched people: avatar inlining is optional,
  // and a co-author with no face must fall into "+N" rather than disappear.
  const faces = coAuthors.filter((coAuthor) => coAuthor.avatarDataUrl).length;
  const hidden = Math.max(0, total - faces);
  if (faces === 0 && hidden === 0) {
    return nothing;
  }
  const label = t("githubPreview.coAuthors", {
    logins: coAuthors.map((coAuthor) => coAuthor.login).join(", "),
  });
  return html`<span
    class="github-link-hovercard__coauthors"
    title=${label}
    role="img"
    aria-label=${label}
    >${coAuthors.map((coAuthor) => renderAvatar(coAuthor.avatarDataUrl))}${hidden > 0
      ? html`<span class="github-link-hovercard__coauthors-more">+${hidden}</span>`
      : nothing}</span
  >`;
}

function renderCardLink(className: string, href: string, content: string | TemplateResult) {
  return html`<a
    class=${className}
    href=${href}
    target=${EXTERNAL_LINK_TARGET}
    rel=${buildExternalLinkRel()}
    >${content}</a
  >`;
}

function renderLoading(card: HTMLDivElement): void {
  card.dataset.loading = "true";
  card.removeAttribute("data-state");
  card.setAttribute("aria-label", t("githubPreview.loading"));
  const rows = [
    ["header", ["badge", "repo", "time"]],
    ["title", ["title"]],
    ["footer", ["author", "metrics"]],
  ] as const;
  render(
    html`<div class="github-link-hovercard__skeleton" aria-hidden="true">
      ${rows.map(
        ([rowClass, parts]) =>
          html`<div class=${`github-link-hovercard__${rowClass}`}>
            ${parts.map(
              (part) =>
                html`<span class=${`skeleton github-link-hovercard__placeholder--${part}`}></span>`,
            )}
          </div>`,
      )}
    </div>`,
    card,
  );
}

function renderUnavailable(card: HTMLDivElement, error: string): void {
  card.dataset.loading = "false";
  card.dataset.state = "unavailable";
  const label = t("githubPreview.unavailable");
  card.setAttribute("aria-label", label);
  const showError = error && error !== label;
  const errorId = `${card.id}-error`;
  if (showError) {
    card.setAttribute("aria-describedby", errorId);
  }
  render(
    html`<div class="github-link-hovercard__unavailable">
      <div>${label}</div>
      ${showError
        ? html`<div class="github-link-hovercard__error" id=${errorId}>${error}</div>`
        : nothing}
    </div>`,
    card,
  );
}

function renderPreview(card: HTMLDivElement, preview: GitHubPreview): void {
  card.dataset.loading = "false";
  const state = previewState(preview);
  card.dataset.state = state.tone;
  const comments = preview.comments ?? 0;
  render(
    html`<div class="github-link-hovercard__header">
        <span class="github-link-hovercard__state" data-tone=${state.tone}
          ><span class="github-link-hovercard__state-dot" aria-hidden="true"></span
          >${state.label}</span
        >
        ${renderCardLink(
          "github-link-hovercard__repo",
          preview.href,
          `${preview.owner}/${preview.repo} #${preview.number}`,
        )}
        <time class="github-link-hovercard__time"
          >${formatRelativeTimestamp(Date.parse(preview.updatedAt))}</time
        >
      </div>
      ${renderCardLink("github-link-hovercard__title", preview.href, preview.title)}
      <div class="github-link-hovercard__footer">
        ${renderCardLink(
          "github-link-hovercard__author",
          gitHubProfileUrl(preview.login),
          html`${renderAvatar(preview.avatarDataUrl)}${preview.login}`,
        )}${renderCoAuthors(preview)}
        ${preview.kind === "pull"
          ? html`<span class="github-link-hovercard__metrics github-link-hovercard__metrics--diff">
              <span class="github-link-hovercard__metric github-link-hovercard__metric--additions"
                >+${preview.additions ?? 0}</span
              >
              <span class="github-link-hovercard__metric github-link-hovercard__metric--deletions"
                >−${preview.deletions ?? 0}</span
              >
            </span>`
          : html`<span class="github-link-hovercard__metrics">
              <span class="github-link-hovercard__metric"
                >${t(comments === 1 ? "githubPreview.comment" : "githubPreview.comments", {
                  count: String(comments),
                })}</span
              >
            </span>`}
      </div>`,
    card,
  );
  card.setAttribute(
    "aria-label",
    t("githubPreview.ariaLabel", {
      state: state.label,
      kind: preview.kind === "pull" ? t("githubPreview.pullRequest") : t("githubPreview.issue"),
      repo: `${preview.owner}/${preview.repo}`,
      number: String(preview.number),
      title: preview.title,
      author: preview.login,
    }),
  );
}

export class GitHubLinkHovercardProvider extends ReactiveElement {
  // Lit must replay values assigned before the lazy custom element upgrades,
  // otherwise own properties shadow the identity-resetting accessors below.
  static override properties = {
    client: { attribute: false, noAccessor: true },
    agentId: { attribute: false, noAccessor: true },
  };

  private gatewayClient: GatewayBrowserClient | null = null;
  private selectedAgentId: string | undefined;

  get client(): GatewayBrowserClient | null {
    return this.gatewayClient;
  }

  set client(value: GatewayBrowserClient | null) {
    if (value === this.gatewayClient) {
      return;
    }
    this.close();
    this.cache.clear();
    this.gatewayClient = value;
  }

  get agentId(): string | undefined {
    return this.selectedAgentId;
  }

  set agentId(value: string | undefined) {
    if (value === this.selectedAgentId) {
      return;
    }
    this.close();
    this.cache.clear();
    this.selectedAgentId = value;
  }

  private readonly cache = new Map<string, CacheEntry>();
  private activeAnchor: HTMLAnchorElement | null = null;
  private activeTarget: GitHubLinkTarget | null = null;
  // Which surface opened the current card: gates whether focus landing inside
  // the portaled card (e.g. clicking the title link) can hold it open, so a
  // pointer-driven open still fully releases on mouse-out (see handleCardPointerLeave).
  private activeTrigger: "focus" | "pointer" | null = null;
  private readonly hovercard = new PortaledHovercardController(() => this.close());
  private stopI18n: (() => void) | null = null;
  // Spans the synchronous focus() that hands focus back to the trigger, so the
  // card the user just dismissed cannot reopen under them (handleCardKeyDown).
  private suppressFocusOpen = false;
  private readonly previewTask = new Task(this, {
    autoRun: false,
    args: () => [this.activeTarget] as const,
    // Share metadata, not navigation: each activation owns its full validated URL.
    task: async ([target], { signal }) =>
      target ? { ...(await this.loadPreview(target, signal)), ...target } : initialState,
  });
  private readonly activeAnchorObserver = new MutationObserver(() => {
    const anchor = this.activeAnchor;
    // The card is portaled outside the routed tree, whose replacement can remove
    // a hovered link without a pointer event reaching this delegated handler.
    if (anchor && !this.contains(anchor)) {
      this.close();
    }
  });

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "contents";
    this.addEventListener("pointerover", this.handlePointerOver);
    this.addEventListener("pointerout", this.handlePointerOut);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
    this.addEventListener("keydown", this.handleKeyDown);
    this.addEventListener("click", this.handleClick);
    this.stopI18n ??= i18n.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.handleKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.stopI18n?.();
    this.stopI18n = null;
    this.close();
    super.disconnectedCallback();
  }

  protected override updated(): void {
    const card = this.hovercard.card;
    if (!card) {
      return;
    }
    card.removeAttribute("aria-describedby");
    this.previewTask.render({
      initial: () => renderLoading(card),
      pending: () => renderLoading(card),
      complete: (preview) => renderPreview(card, preview),
      error: (error) => renderUnavailable(card, truncateUtf16Safe(formatUiError(error), 320)),
    });
    this.hovercard.position();
  }

  private readonly handlePointerOver = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "touch") {
      return;
    }
    const anchor = githubLinkAnchorFromEvent(event);
    const target = anchor ? parseGitHubLinkTarget(anchor.href) : null;
    if (!anchor || !target) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "pointer", GITHUB_HOVERCARD_OPEN_DELAY_MS);
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const anchor = githubLinkAnchorFromEvent(event);
    if (!anchor || anchor !== this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.pointerInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleCardPointerEnter = () => {
    this.hovercard.pointerOverCard = true;
    this.hovercard.clearClose();
  };

  private readonly handleCardPointerLeave = () => {
    this.hovercard.pointerOverCard = false;
    // A pointer-opened card must release fully on mouse-out even if a click
    // inside the card (e.g. the title link) left it focused; otherwise it
    // would stay stuck open with nothing left driving the intent.
    if (this.activeTrigger === "pointer") {
      this.hovercard.cardFocusInside = false;
    }
    this.hovercard.scheduleClose();
  };

  // The card is portaled to document.body, so focus landing on its title link
  // never reaches the provider's delegated focusin/focusout listeners; track it
  // directly so keyboard users can tab into the link without losing the card.
  private readonly handleCardFocusIn = () => {
    this.hovercard.cardFocusInside = true;
    this.hovercard.clearClose();
  };

  private readonly handleCardFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && this.hovercard.card?.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.cardFocusInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleFocusIn = (event: Event) => {
    if (this.suppressFocusOpen) {
      return;
    }
    const anchor = githubLinkAnchorFromEvent(event);
    const target = anchor ? parseGitHubLinkTarget(anchor.href) : null;
    if (!anchor || !target) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "focus", 0);
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeAnchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.focusInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
      return;
    }
    // The card is portaled to document.body and never lands next to its trigger
    // in the tab sequence; forward Tab in, and let the card hand focus back
    // (handleCardKeyDown), so its links stay keyboard-reachable at all.
    if (event.key !== "Tab" || event.shiftKey || event.target !== this.activeAnchor) {
      return;
    }
    const [first] = this.hovercard.focusables();
    if (!first) {
      return;
    }
    event.preventDefault();
    first.focus();
  };

  private readonly handleCardKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" && event.key !== "Tab") {
      return;
    }
    // Tab moves between the card's own links normally and only exits at the edge
    // of that run: the card has no tab-sequence neighbour, so leaving it lands on
    // the trigger like Escape does instead of dropping focus to the document.
    const focusables = this.hovercard.focusables();
    const edge = event.shiftKey ? focusables[0] : focusables.at(-1);
    if (event.key === "Tab" && document.activeElement !== edge) {
      return;
    }
    event.preventDefault();
    const anchor = this.activeAnchor;
    this.close();
    this.suppressFocusOpen = true;
    anchor?.focus({ preventScroll: true });
    this.suppressFocusOpen = false;
  };

  private readonly handleClick = () => {
    this.close();
  };

  activateFromBootstrap(
    anchor: HTMLAnchorElement,
    target: GitHubLinkTarget,
    trigger: "focus" | "pointer",
    delay: number,
  ): void {
    this.activate(anchor, target, delay);
    this.activeTrigger = trigger;
    if (trigger === "pointer") {
      this.hovercard.pointerInside = true;
    } else {
      this.hovercard.focusInside = true;
    }
  }

  private activate(anchor: HTMLAnchorElement, target: GitHubLinkTarget, delay: number): void {
    if (anchor === this.activeAnchor && this.activeTarget?.href === target.href) {
      return;
    }
    this.close();
    this.activeAnchor = anchor;
    this.activeTarget = target;
    // Announce the popup affordance as soon as the link is recognized; show()
    // flips the state once the card exists, close() takes the whole set away.
    this.hovercard.markTrigger(anchor);
    this.activeAnchorObserver.observe(this, { childList: true, subtree: true });
    this.hovercard.scheduleOpen(delay, () => this.show(anchor, target));
  }

  private show(anchor: HTMLAnchorElement, target: GitHubLinkTarget): void {
    if (this.activeAnchor !== anchor || this.activeTarget?.href !== target.href) {
      return;
    }
    nextHovercardId += 1;
    const card = createPortaledHovercard(
      `openclaw-github-hovercard-${nextHovercardId}`,
      "github-link-hovercard",
    );
    renderLoading(card);
    // The card is portaled to document.body, so the provider's delegated pointer
    // listeners never see it; it reports its own hover to keep intent shared.
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("focusin", this.handleCardFocusIn);
    card.addEventListener("focusout", this.handleCardFocusOut);
    card.addEventListener("keydown", this.handleCardKeyDown);
    this.hovercard.mount(anchor, card, "vertical", true, () => render(nothing, card));

    void this.previewTask.run([target]);
  }

  private loadPreview(
    target: GitHubLinkTarget,
    signal: AbortSignal,
  ): Promise<ControlUiGitHubPreview> {
    const key = `${target.kind}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    this.cache.delete(key);
    // Dismissal invalidates only that request, even before its rejection settles.
    if (cached && !cached.signal.aborted && cached.expiresAt > now) {
      this.cache.set(key, cached);
      return cached.promise;
    }

    const load = async (): Promise<ControlUiGitHubPreview> => {
      if (!this.client) {
        throw new Error("GitHub preview requires a connected Gateway");
      }
      const response = await this.client.request<ControlUiGitHubPreview>(
        "controlUi.githubPreview",
        {
          ...(this.agentId ? { agentId: this.agentId } : {}),
          kind: target.kind,
          number: target.number,
          owner: target.owner,
          repo: target.repo,
        },
        { signal },
      );
      return parsePreviewResponse(target, response);
    };

    const entry: CacheEntry = {
      expiresAt: now + SUCCESS_CACHE_MS,
      signal,
      promise: load().catch((error: unknown) => {
        // Keep short-lived failures cached so repeatedly crossing a broken or
        // private link does not burn GitHub's anonymous rate limit.
        entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
        throw error;
      }),
    };
    this.cache.set(key, entry);
    while (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.cache.delete(oldestKey);
    }
    return entry.promise;
  }

  private close(): void {
    this.hovercard.reset();
    this.activeAnchorObserver.disconnect();
    void this.previewTask.run([null]);
    this.activeAnchor = null;
    this.activeTarget = null;
    this.activeTrigger = null;
  }
}
