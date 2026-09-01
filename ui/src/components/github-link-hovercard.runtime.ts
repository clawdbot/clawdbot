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

function coAuthorAvatarElement(dataUrl: string): HTMLImageElement {
  const avatar = document.createElement("img");
  avatar.className = "github-link-hovercard__avatar";
  avatar.alt = "";
  avatar.decoding = "async";
  avatar.referrerPolicy = "no-referrer";
  avatar.src = dataUrl;
  return avatar;
}

/**
 * Overlapping faces after the author, plus "+N" for anyone past the fetched
 * three. The group is one labelled image: names reach assistive tech through
 * its accessible name instead of competing with the metrics for row width.
 */
function appendCoAuthors(author: HTMLElement, preview: GitHubPreview): void {
  const coAuthors = preview.coAuthors ?? [];
  const total = preview.coAuthorCount ?? coAuthors.length;
  if (coAuthors.length === 0) {
    return;
  }
  const stack = document.createElement("span");
  stack.className = "github-link-hovercard__coauthors";
  let faces = 0;
  for (const coAuthor of coAuthors) {
    if (coAuthor.avatarDataUrl) {
      stack.append(coAuthorAvatarElement(coAuthor.avatarDataUrl));
      faces += 1;
    }
  }
  // Counted from rendered faces, not fetched people: avatar inlining is optional,
  // and a co-author with no face must fall into "+N" rather than disappear.
  const hidden = Math.max(0, total - faces);
  if (hidden > 0) {
    const more = document.createElement("span");
    more.className = "github-link-hovercard__coauthors-more";
    more.textContent = `+${hidden}`;
    stack.append(more);
  }
  if (stack.childElementCount === 0) {
    return;
  }
  // The faces are decorative images, so the group carries the only accessible
  // name; a title alone is never announced.
  const label = t("githubPreview.coAuthors", {
    logins: coAuthors.map((coAuthor) => coAuthor.login).join(", "),
  });
  stack.title = label;
  stack.role = "img";
  stack.ariaLabel = label;
  author.after(stack);
}

function appendMetric(parent: HTMLElement, className: string, text: string): void {
  appendTextElement(parent, "span", `github-link-hovercard__metric ${className}`, text);
}

function appendCardLink(
  parent: HTMLElement,
  className: string,
  href: string,
  text: string,
): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = className;
  link.href = href;
  link.target = EXTERNAL_LINK_TARGET;
  link.rel = buildExternalLinkRel();
  link.textContent = text;
  parent.append(link);
  return link;
}

function renderLoading(card: HTMLDivElement): void {
  card.replaceChildren();
  card.dataset.loading = "true";
  card.removeAttribute("data-state");
  const label = t("githubPreview.loading");
  // The card is a dialog, so every render state has to leave it with a name.
  card.setAttribute("aria-label", label);
  const skeleton = appendTextElement(card, "div", "github-link-hovercard__skeleton", "");
  skeleton.setAttribute("aria-hidden", "true");
  for (const [rowClass, parts] of [
    ["header", ["badge", "repo", "time"]],
    ["title", ["title"]],
    ["footer", ["author", "metrics"]],
  ] as const) {
    const row = appendTextElement(skeleton, "div", `github-link-hovercard__${rowClass}`, "");
    for (const part of parts) {
      appendTextElement(row, "span", `skeleton github-link-hovercard__placeholder--${part}`, "");
    }
  }
}

function renderUnavailable(card: HTMLDivElement): void {
  card.replaceChildren();
  card.dataset.loading = "false";
  card.dataset.state = "unavailable";
  const label = t("githubPreview.unavailable");
  card.setAttribute("aria-label", label);
  appendTextElement(card, "div", "github-link-hovercard__unavailable", label);
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
  // Every link on the card reuses the href it was activated with; that target is
  // already resolved and validated by parseGitHubLinkTarget, so no reparsing here.
  appendCardLink(
    header,
    "github-link-hovercard__repo",
    preview.href,
    `${preview.owner}/${preview.repo} #${preview.number}`,
  );
  appendTextElement(
    header,
    "time",
    "github-link-hovercard__time",
    formatRelativeTimestamp(Date.parse(preview.updatedAt)),
  );

  const footer = document.createElement("div");
  footer.className = "github-link-hovercard__footer";
  const author = appendCardLink(
    footer,
    "github-link-hovercard__author",
    gitHubProfileUrl(preview.login),
    preview.login,
  );
  if (preview.avatarDataUrl) {
    author.prepend(coAuthorAvatarElement(preview.avatarDataUrl));
  }
  appendCoAuthors(author, preview);

  const metrics = document.createElement("span");
  metrics.className = "github-link-hovercard__metrics";
  if (preview.kind === "pull") {
    metrics.classList.add("github-link-hovercard__metrics--diff");
    appendMetric(metrics, "github-link-hovercard__metric--additions", `+${preview.additions ?? 0}`);
    appendMetric(metrics, "github-link-hovercard__metric--deletions", `−${preview.deletions ?? 0}`);
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
  card.append(header);
  appendCardLink(card, "github-link-hovercard__title", preview.href, preview.title);
  card.append(footer);
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
  private readonly hovercard = new PortaledHovercardController(() => this.close());
  private renderedPreview: GitHubPreview | null = null;
  private renderedUnavailable = false;
  private stopI18n: (() => void) | null = null;
  // Spans the synchronous focus() that hands focus back to the trigger, so the
  // card the user just dismissed cannot reopen under them (handleCardKeyDown).
  private suppressFocusOpen = false;
  private readonly previewTask = new Task(this, {
    autoRun: false,
    args: () => [this.activeTarget] as const,
    task: ([target], { signal }) => (target ? this.loadPreview(target, signal) : initialState),
    onComplete: (preview) => {
      const card = this.hovercard.card;
      if (!card) {
        return;
      }
      this.renderedPreview = preview;
      renderPreview(card, preview);
      this.hovercard.position();
    },
    onError: () => {
      const card = this.hovercard.card;
      if (!card) {
        return;
      }
      this.renderedUnavailable = true;
      renderUnavailable(card);
      this.hovercard.position();
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
    const card = this.hovercard.card;
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
    this.hovercard.position();
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
    const [first] = this.cardFocusables();
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
    const focusables = this.cardFocusables();
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

  private cardFocusables(): HTMLElement[] {
    return [...(this.hovercard.card?.querySelectorAll<HTMLElement>("a[href]") ?? [])];
  }

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
    // A tooltip may not own controls: its content is flattened and unreachable.
    // The card is a non-modal dialog instead, named by the render functions.
    this.renderedPreview = null;
    this.renderedUnavailable = false;
    renderLoading(card);
    // The card is portaled to document.body, so the provider's delegated pointer
    // listeners never see it; it reports its own hover to keep intent shared.
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("focusin", this.handleCardFocusIn);
    card.addEventListener("focusout", this.handleCardFocusOut);
    card.addEventListener("keydown", this.handleCardKeyDown);
    this.hovercard.mount(anchor, card, "vertical");

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
    this.hovercard.reset();
    this.activeAnchorObserver.disconnect();
    void this.previewTask.run([null]);
    this.renderedPreview = null;
    this.renderedUnavailable = false;
    this.activeAnchor = null;
    this.activeTarget = null;
    this.activeTrigger = null;
  }
}
