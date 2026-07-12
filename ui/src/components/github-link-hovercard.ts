import type { ControlUiGitHubPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n, t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";

const GITHUB_HOST = "github.com";
const OPEN_DELAY_MS = 250;
const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;
const VIEWPORT_PADDING = 12;
const CARD_GAP = 10;

type GitHubLinkKind = "issue" | "pull";

type GitHubLinkTarget = {
  href: string;
  kind: GitHubLinkKind;
  number: number;
  owner: string;
  repo: string;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`GitHub response omitted ${key}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && decoded !== "." && decoded !== ".." ? decoded : null;
  } catch {
    return null;
  }
}

export function parseGitHubIssueOrPullRequestLink(href: string): GitHubLinkTarget | null {
  let url: URL;
  try {
    url = new URL(href, globalThis.location?.href ?? "http://localhost/");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== GITHUB_HOST) {
    return null;
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = decodePathSegment(segments[0] ?? "");
  const repo = decodePathSegment(segments[1] ?? "");
  const surface = segments[2];
  const numberText = segments[3] ?? "";
  if (!owner || !repo || !/^[1-9]\d{0,9}$/.test(numberText)) {
    return null;
  }
  const kind = surface === "issues" ? "issue" : surface === "pull" ? "pull" : null;
  if (!kind) {
    return null;
  }
  return { href: url.href, kind, number: Number(numberText), owner, repo };
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
    additions: optionalNumber(value, "additions"),
    avatarDataUrl: safeAvatarDataUrl(value.avatarDataUrl),
    changedFiles: optionalNumber(value, "changedFiles"),
    closedAt: optionalString(value, "closedAt"),
    comments: optionalNumber(value, "comments"),
    createdAt: requiredString(value, "createdAt"),
    deletions: optionalNumber(value, "deletions"),
    draft: typeof value.draft === "boolean" ? value.draft : undefined,
    kind: target.kind,
    login: optionalString(value, "login") ?? "ghost",
    mergedAt: optionalString(value, "mergedAt"),
    number: target.number,
    owner: target.owner,
    repo: target.repo,
    state: requiredString(value, "state"),
    stateReason: optionalString(value, "stateReason"),
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

  const title = document.createElement("div");
  title.className = "github-link-hovercard__title";
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

function anchorFromEvent(event: Event): HTMLAnchorElement | null {
  for (const candidate of event.composedPath()) {
    if (candidate instanceof HTMLAnchorElement) {
      return candidate;
    }
    if (candidate === event.currentTarget) {
      break;
    }
  }
  return null;
}

export class GitHubLinkHovercardProvider extends HTMLElement {
  client: GatewayBrowserClient | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private activeAnchor: HTMLAnchorElement | null = null;
  private activeTarget: GitHubLinkTarget | null = null;
  private card: HTMLDivElement | null = null;
  private describedBy: string | null = null;
  private focusInside = false;
  private openTimer: number | null = null;
  private pointerInside = false;
  private renderedPreview: GitHubPreview | null = null;
  private renderedUnavailable = false;
  private requestVersion = 0;
  private stopI18n: (() => void) | null = null;

  connectedCallback(): void {
    this.style.display = "contents";
    this.addEventListener("pointerover", this.handlePointerOver);
    this.addEventListener("pointerout", this.handlePointerOut);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
    this.addEventListener("keydown", this.handleKeyDown);
    this.addEventListener("click", this.handleClick);
    this.stopI18n ??= i18n.subscribe(this.handleLocaleChange);
  }

  disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.handleKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.stopI18n?.();
    this.stopI18n = null;
    this.close();
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
    const anchor = anchorFromEvent(event);
    const target = anchor ? parseGitHubIssueOrPullRequestLink(anchor.href) : null;
    if (!anchor || !target) {
      return;
    }
    this.activate(anchor, target, OPEN_DELAY_MS);
    this.pointerInside = true;
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const anchor = anchorFromEvent(event);
    if (!anchor || anchor !== this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
      return;
    }
    this.pointerInside = false;
    if (!this.focusInside) {
      this.close();
    }
  };

  private readonly handleFocusIn = (event: Event) => {
    const anchor = anchorFromEvent(event);
    const target = anchor ? parseGitHubIssueOrPullRequestLink(anchor.href) : null;
    if (!anchor || !target) {
      return;
    }
    this.activate(anchor, target, 0);
    this.focusInside = true;
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeAnchor.contains(event.relatedTarget)) {
      return;
    }
    this.focusInside = false;
    if (!this.pointerInside) {
      this.close();
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
    }
  };

  private readonly handleClick = () => {
    this.close();
  };

  private activate(anchor: HTMLAnchorElement, target: GitHubLinkTarget, delay: number): void {
    if (anchor === this.activeAnchor && this.activeTarget?.href === target.href) {
      return;
    }
    this.close();
    this.activeAnchor = anchor;
    this.activeTarget = target;
    this.describedBy = anchor.getAttribute("aria-describedby");
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      void this.show(anchor, target);
    }, delay);
  }

  private async show(anchor: HTMLAnchorElement, target: GitHubLinkTarget): Promise<void> {
    if (this.activeAnchor !== anchor || this.activeTarget?.href !== target.href) {
      return;
    }
    const version = ++this.requestVersion;
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
    document.body.append(card);
    this.card = card;
    anchor.setAttribute(
      "aria-describedby",
      this.describedBy ? `${this.describedBy} ${card.id}` : card.id,
    );
    this.listenForViewportChanges();
    this.positionCard();

    try {
      const preview = await this.loadPreview(target);
      if (version !== this.requestVersion || card !== this.card) {
        return;
      }
      this.renderedPreview = preview;
      renderPreview(card, preview);
    } catch {
      if (version !== this.requestVersion || card !== this.card) {
        return;
      }
      this.renderedUnavailable = true;
      renderUnavailable(card);
    }
    this.positionCard();
  }

  private loadPreview(target: GitHubLinkTarget): Promise<GitHubPreview> {
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
    this.requestVersion += 1;
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
    this.describedBy = null;
    this.focusInside = false;
    this.pointerInside = false;
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

if (!customElements.get("openclaw-github-link-hovercard-provider")) {
  customElements.define("openclaw-github-link-hovercard-provider", GitHubLinkHovercardProvider);
}
