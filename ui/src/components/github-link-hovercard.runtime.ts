import { initialState, Task } from "@lit/task";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { ReactiveElement } from "lit";
import type { ControlUiGitHubPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n, t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import {
  GITHUB_HOVERCARD_OPEN_DELAY_MS,
  githubLinkAnchorFromEvent,
  parseGitHubLinkTarget,
  type GitHubLinkTarget,
} from "./github-link-target.ts";

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;
const VIEWPORT_PADDING = 12;
const CARD_GAP = 10;
// Traversal grace: the pointer has to cross CARD_GAP of unowned page between the
// link and the card, and neither surface is hovered during that crossing.
const CLOSE_DELAY_MS = 120;

type GitHubPreview = GitHubLinkTarget & ControlUiGitHubPreview;

type PreviewState = {
  label: string;
  tone: "danger" | "muted" | "open" | "purple";
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<GitHubPreview>;
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

function parsePreviewResponse(target: GitHubLinkTarget, value: unknown): GitHubPreview {
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
    ...target,
    additions: asFiniteNumber(value.additions),
    avatarDataUrl: safeAvatarDataUrl(value.avatarDataUrl),
    changedFiles: asFiniteNumber(value.changedFiles),
    closedAt: readNonBlankString(value.closedAt),
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

function appendTextElement(
  parent: HTMLElement,
  tagName: keyof HTMLElementTagNameMap,
  className: string,
  text: string,
): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function appendMetric(parent: HTMLElement, className: string, text: string): void {
  appendTextElement(parent, "span", `github-link-hovercard__metric ${className}`, text);
}

function renderLoading(card: HTMLDivElement): void {
  card.replaceChildren();
  card.dataset.loading = "true";
  card.removeAttribute("data-state");
  appendTextElement(card, "div", "github-link-hovercard__loading", t("githubPreview.loading"));
}

function renderUnavailable(card: HTMLDivElement): void {
  card.replaceChildren();
  card.dataset.loading = "false";
  card.dataset.state = "unavailable";
  appendTextElement(
    card,
    "div",
    "github-link-hovercard__unavailable",
    t("githubPreview.unavailable"),
  );
}

function renderPreview(card: HTMLDivElement, preview: GitHubPreview): void {
  card.replaceChildren();
  card.dataset.loading = "false";
  const state = previewState(preview);
  card.dataset.state = state.tone;

  const header = document.createElement("div");
  header.className = "github-link-hovercard__header";
  const badge = document.createElement("span");
  badge.className = "github-link-hovercard__state";
  badge.dataset.tone = state.tone;
  const stateDot = document.createElement("span");
  stateDot.className = "github-link-hovercard__state-dot";
  stateDot.setAttribute("aria-hidden", "true");
  badge.append(stateDot, document.createTextNode(state.label));
  header.append(badge);
  appendTextElement(
    header,
    "span",
    "github-link-hovercard__repo",
    `${preview.owner}/${preview.repo} #${preview.number}`,
  );
  appendTextElement(
    header,
    "time",
    "github-link-hovercard__time",
    formatRelativeTimestamp(Date.parse(preview.updatedAt)),
  );

  const title = document.createElement("a");
  title.className = "github-link-hovercard__title";
  // Reuse the href the card was activated with; the target is already
  // resolved and validated by parseGitHubLinkTarget, so no new parsing here.
  title.href = preview.href;
  title.target = EXTERNAL_LINK_TARGET;
  title.rel = buildExternalLinkRel();
  title.textContent = preview.title;

  const footer = document.createElement("div");
  footer.className = "github-link-hovercard__footer";
  const author = document.createElement("span");
  author.className = "github-link-hovercard__author";
  if (preview.avatarDataUrl) {
    const avatar = document.createElement("img");
    avatar.className = "github-link-hovercard__avatar";
    avatar.alt = "";
    avatar.decoding = "async";
    avatar.referrerPolicy = "no-referrer";
    avatar.src = preview.avatarDataUrl;
    author.append(avatar);
  }
  author.append(document.createTextNode(preview.login));
  footer.append(author);

  const metrics = document.createElement("span");
  metrics.className = "github-link-hovercard__metrics";
  if (preview.kind === "pull") {
    appendMetric(metrics, "github-link-hovercard__metric--additions", `+${preview.additions ?? 0}`);
    appendMetric(metrics, "github-link-hovercard__metric--deletions", `−${preview.deletions ?? 0}`);
    const files = preview.changedFiles ?? 0;
    appendMetric(
      metrics,
      "",
      t(files === 1 ? "githubPreview.file" : "githubPreview.files", {
        count: String(files),
      }),
    );
  } else {
    const comments = preview.comments ?? 0;
    appendMetric(
      metrics,
      "",
      t(comments === 1 ? "githubPreview.comment" : "githubPreview.comments", {
        count: String(comments),
      }),
    );
  }
  footer.append(metrics);
  card.append(header, title, footer);
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
  client: GatewayBrowserClient | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private activeAnchor: HTMLAnchorElement | null = null;
  private activeTarget: GitHubLinkTarget | null = null;
  // Which surface opened the current card: gates whether focus landing inside
  // the portaled card (e.g. clicking the title link) can hold it open, so a
  // pointer-driven open still fully releases on mouse-out (see handleCardPointerLeave).
  private activeTrigger: "focus" | "pointer" | null = null;
  private card: HTMLDivElement | null = null;
  private cardFocusInside = false;
  private closeTimer: number | null = null;
  private describedBy: string | null = null;
  private focusInside = false;
  private openTimer: number | null = null;
  private pointerInside = false;
  private pointerOverCard = false;
  private renderedPreview: GitHubPreview | null = null;
  private renderedUnavailable = false;
  private stopI18n: (() => void) | null = null;
  private readonly previewTask = new Task(this, {
    autoRun: false,
    args: () => [this.activeTarget] as const,
    task: ([target], { signal }) => (target ? this.loadPreview(target, signal) : initialState),
    onComplete: (preview) => {
      const card = this.card;
      if (!card) {
        return;
      }
      this.renderedPreview = preview;
      renderPreview(card, preview);
      this.positionCard();
    },
    onError: () => {
      const card = this.card;
      if (!card) {
        return;
      }
      this.renderedUnavailable = true;
      renderUnavailable(card);
      this.positionCard();
    },
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
    this.stopI18n ??= i18n.subscribe(this.handleLocaleChange);
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

  private readonly handleLocaleChange = () => {
    const card = this.card;
    if (!card) {
      return;
    }
    if (this.renderedPreview) {
      renderPreview(card, this.renderedPreview);
    } else if (this.renderedUnavailable) {
      renderUnavailable(card);
    } else {
      renderLoading(card);
    }
    this.positionCard();
  };

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
    this.pointerInside = false;
    this.scheduleClose();
  };

  private readonly handleCardPointerEnter = () => {
    this.pointerOverCard = true;
    this.clearCloseTimer();
  };

  private readonly handleCardPointerLeave = () => {
    this.pointerOverCard = false;
    // A pointer-opened card must release fully on mouse-out even if a click
    // inside the card (e.g. the title link) left it focused; otherwise it
    // would stay stuck open with nothing left driving the intent.
    if (this.activeTrigger === "pointer") {
      this.cardFocusInside = false;
    }
    this.scheduleClose();
  };

  // The card is portaled to document.body, so focus landing on its title link
  // never reaches the provider's delegated focusin/focusout listeners; track it
  // directly so keyboard users can tab into the link without losing the card.
  private readonly handleCardFocusIn = () => {
    this.cardFocusInside = true;
    this.clearCloseTimer();
  };

  private readonly handleCardFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && this.card?.contains(event.relatedTarget)) {
      return;
    }
    this.cardFocusInside = false;
    this.scheduleClose();
  };

  private readonly handleFocusIn = (event: Event) => {
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
    this.focusInside = false;
    this.scheduleClose();
  };

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  // Hover intent spans link and card: dismissal waits out the traversal grace and
  // re-checks every surface that holds the card open, so moving from one to the
  // other keeps it alive and only leaving both closes it.
  private scheduleClose(): void {
    this.clearCloseTimer();
    if (this.hoverIntentHeld) {
      return;
    }
    // Without a card there is only a pending open timer, and no gap to cross:
    // cancel the open now instead of granting grace to a card that never showed.
    if (!this.card) {
      this.close();
      return;
    }
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (!this.hoverIntentHeld) {
        this.close();
      }
    }, CLOSE_DELAY_MS);
  }

  private get hoverIntentHeld(): boolean {
    return this.pointerInside || this.pointerOverCard || this.focusInside || this.cardFocusInside;
  }

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
    }
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
      this.pointerInside = true;
    } else {
      this.focusInside = true;
    }
  }

  private activate(anchor: HTMLAnchorElement, target: GitHubLinkTarget, delay: number): void {
    if (anchor === this.activeAnchor && this.activeTarget?.href === target.href) {
      return;
    }
    this.close();
    this.activeAnchor = anchor;
    this.activeTarget = target;
    this.describedBy = anchor.getAttribute("aria-describedby");
    this.activeAnchorObserver.observe(this, { childList: true, subtree: true });
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      this.show(anchor, target);
    }, delay);
  }

  private show(anchor: HTMLAnchorElement, target: GitHubLinkTarget): void {
    if (this.activeAnchor !== anchor || this.activeTarget?.href !== target.href) {
      return;
    }
    const card = document.createElement("div");
    nextHovercardId += 1;
    card.id = `openclaw-github-hovercard-${nextHovercardId}`;
    card.className = "github-link-hovercard";
    card.dataset.open = "true";
    card.setAttribute("role", "tooltip");
    card.setAttribute("aria-live", "polite");
    this.renderedPreview = null;
    this.renderedUnavailable = false;
    renderLoading(card);
    // The card is portaled to document.body, so the provider's delegated pointer
    // listeners never see it; it reports its own hover to keep intent shared.
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("focusin", this.handleCardFocusIn);
    card.addEventListener("focusout", this.handleCardFocusOut);
    document.body.append(card);
    this.card = card;
    anchor.setAttribute(
      "aria-describedby",
      this.describedBy ? `${this.describedBy} ${card.id}` : card.id,
    );
    this.listenForViewportChanges();
    this.positionCard();

    void this.previewTask.run([target]);
  }

  private loadPreview(target: GitHubLinkTarget, signal: AbortSignal): Promise<GitHubPreview> {
    const key = `${target.kind}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.promise;
    }
    if (cached) {
      this.cache.delete(key);
    }

    const load = async (): Promise<GitHubPreview> => {
      if (!this.client) {
        throw new Error("GitHub preview requires a connected Gateway");
      }
      const response = await this.client.request<ControlUiGitHubPreview>(
        "controlUi.githubPreview",
        {
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
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.clearCloseTimer();
    this.activeAnchorObserver.disconnect();
    void this.previewTask.run([null]);
    if (this.activeAnchor) {
      if (this.describedBy === null) {
        this.activeAnchor.removeAttribute("aria-describedby");
      } else {
        this.activeAnchor.setAttribute("aria-describedby", this.describedBy);
      }
    }
    this.card?.remove();
    this.card = null;
    this.renderedPreview = null;
    this.renderedUnavailable = false;
    this.activeAnchor = null;
    this.activeTarget = null;
    this.activeTrigger = null;
    this.describedBy = null;
    this.cardFocusInside = false;
    this.focusInside = false;
    this.pointerInside = false;
    this.pointerOverCard = false;
    this.stopListeningForViewportChanges();
  }

  private readonly handleViewportChange = () => {
    this.positionCard();
  };

  private listenForViewportChanges(): void {
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("scroll", this.handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", this.handleViewportChange);
    window.visualViewport?.addEventListener("scroll", this.handleViewportChange);
  }

  private stopListeningForViewportChanges(): void {
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    window.visualViewport?.removeEventListener("resize", this.handleViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.handleViewportChange);
  }

  private positionCard(): void {
    const anchor = this.activeAnchor;
    const card = this.card;
    if (!anchor || !card) {
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const fitsBelow =
      anchorRect.bottom + CARD_GAP + cardRect.height + VIEWPORT_PADDING <= innerHeight;
    const side = fitsBelow ? "bottom" : "top";
    const top =
      side === "bottom"
        ? anchorRect.bottom + CARD_GAP
        : anchorRect.top - cardRect.height - CARD_GAP;
    const maxLeft = Math.max(VIEWPORT_PADDING, innerWidth - cardRect.width - VIEWPORT_PADDING);
    const maxTop = Math.max(VIEWPORT_PADDING, innerHeight - cardRect.height - VIEWPORT_PADDING);
    card.dataset.side = side;
    card.style.left = `${Math.min(Math.max(VIEWPORT_PADDING, anchorRect.left), maxLeft)}px`;
    card.style.top = `${Math.min(Math.max(VIEWPORT_PADDING, top), maxTop)}px`;
  }
}
