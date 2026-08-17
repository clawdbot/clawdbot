import { initialState, Task } from "@lit/task";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { controlUiSessionSlug } from "@openclaw/session-url-contract";
import { ReactiveElement } from "lit";
import type { ControlUiSessionPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import { sessionRefFromPath, type SessionPathTarget } from "../app-session-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n, t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { sessionKeyUuid } from "../pages/chat/route-loader-short-cache.ts";
import {
  SESSION_HOVERCARD_OPEN_DELAY_MS,
  sessionLinkAnchorFromEvent,
} from "./session-link-hovercard-target.ts";

const SESSION_LINK_SELECTOR = "a.markdown-session-link[data-session-key]";
const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;
const VIEWPORT_PADDING = 12;
const CARD_GAP = 10;
const CLOSE_DELAY_MS = 120;

type SessionPreview = Extract<ControlUiSessionPreview, { status: "ok" }>;

type SessionPreviewTarget = {
  sessionKey: string;
  agentId: string;
  namespace: "chat" | "dashboard";
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<SessionPreview>;
  value?: SessionPreview;
};

let nextHovercardId = 0;

function parsePreviewResponse(value: unknown): SessionPreview {
  if (!isRecord(value) || value.status !== "ok") {
    throw new Error("Session preview unavailable");
  }
  const sessionKey = readNonBlankString(value.sessionKey);
  const agentId = readNonBlankString(value.agentId);
  if (!sessionKey || !agentId) {
    throw new Error("Session preview response was incomplete");
  }
  return {
    status: "ok",
    sessionKey,
    agentId,
    title: readNonBlankString(value.title),
    derivedTitle: readNonBlankString(value.derivedTitle),
    kind: readNonBlankString(value.kind),
    channel: readNonBlankString(value.channel),
    updatedAt: asFiniteNumber(value.updatedAt),
    lastMessagePreview: readNonBlankString(value.lastMessagePreview),
    archived: typeof value.archived === "boolean" ? value.archived : undefined,
  };
}

function displayTitle(preview: SessionPreview): string | undefined {
  return preview.title ?? preview.derivedTitle;
}

function previewFromRow(row: GatewaySessionRow, target: SessionPreviewTarget): SessionPreview {
  return {
    status: "ok",
    sessionKey: row.key,
    agentId: row.agentId ?? parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
    title: row.displayName ?? undefined,
    derivedTitle: row.derivedTitle,
    kind: row.kind,
    channel: row.channel,
    updatedAt: row.updatedAt ?? undefined,
    lastMessagePreview: row.lastMessagePreview,
    archived: row.archived,
  };
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

function renderLoading(card: HTMLDivElement): void {
  card.replaceChildren();
  card.dataset.loading = "true";
  const label = t("sessionPreview.loading");
  card.setAttribute("aria-label", label);
  appendTextElement(card, "div", "session-link-hovercard__loading", label);
}

function renderUnavailable(card: HTMLDivElement): void {
  card.replaceChildren();
  card.dataset.loading = "false";
  const label = t("sessionPreview.unavailable");
  card.setAttribute("aria-label", label);
  appendTextElement(card, "div", "session-link-hovercard__unavailable", label);
}

function renderPreview(card: HTMLDivElement, preview: SessionPreview): void {
  card.replaceChildren();
  card.dataset.loading = "false";
  const title = displayTitle(preview) ?? preview.sessionKey;
  appendTextElement(card, "div", "session-link-hovercard__title", title);

  const meta = [preview.agentId, preview.kind, preview.channel].filter(Boolean).join(" · ");
  if (meta) {
    appendTextElement(card, "div", "session-link-hovercard__meta", meta);
  }
  if (preview.lastMessagePreview) {
    appendTextElement(card, "div", "session-link-hovercard__message", preview.lastMessagePreview);
  }
  const footer = document.createElement("div");
  footer.className = "session-link-hovercard__footer";
  if (preview.archived) {
    appendTextElement(
      footer,
      "span",
      "session-link-hovercard__archived",
      t("sessionPreview.archived"),
    );
  }
  if (preview.updatedAt !== undefined) {
    appendTextElement(
      footer,
      "time",
      "session-link-hovercard__time",
      formatRelativeTimestamp(preview.updatedAt),
    );
  }
  if (footer.childElementCount > 0) {
    card.append(footer);
  }
  card.setAttribute("aria-label", t("sessionPreview.ariaLabel", { title }));
}

export class SessionLinkHovercardProvider extends ReactiveElement {
  client: GatewayBrowserClient | null = null;
  context: ApplicationContext | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private activeAnchor: HTMLAnchorElement | null = null;
  private activeTarget: SessionPreviewTarget | null = null;
  private card: HTMLDivElement | null = null;
  private closeTimer: number | null = null;
  private focusInside = false;
  private openTimer: number | null = null;
  private pointerInside = false;
  private pointerOverCard = false;
  private renderedPreview: SessionPreview | null = null;
  private renderedUnavailable = false;
  private scanAnimationFrame: number | null = null;
  private readonly pendingAnchors = new Set<HTMLAnchorElement>();
  private stopI18n: (() => void) | null = null;
  private readonly previewTask = new Task(this, {
    autoRun: false,
    args: () => [this.activeTarget] as const,
    task: ([target]) => (target ? this.loadPreview(target) : initialState),
    onComplete: (preview) => {
      const card = this.card;
      if (!card) {
        return;
      }
      this.renderedPreview = preview;
      if (this.activeAnchor?.matches(SESSION_LINK_SELECTOR)) {
        this.stampAnchor(this.activeAnchor, this.activeTarget, preview);
      }
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
  private readonly subtreeObserver = new MutationObserver((records) => {
    if (this.activeAnchor && !this.contains(this.activeAnchor)) {
      this.close();
    }
    let found = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (node instanceof HTMLAnchorElement && node.matches(SESSION_LINK_SELECTOR)) {
          this.pendingAnchors.add(node);
          found = true;
        }
        for (const anchor of node.querySelectorAll<HTMLAnchorElement>(SESSION_LINK_SELECTOR)) {
          this.pendingAnchors.add(anchor);
          found = true;
        }
      }
    }
    if (!found || this.scanAnimationFrame !== null) {
      return;
    }
    this.scanAnimationFrame = requestAnimationFrame(() => {
      this.scanAnimationFrame = null;
      const anchors = [...this.pendingAnchors];
      this.pendingAnchors.clear();
      for (const anchor of anchors) {
        if (anchor.isConnected && this.contains(anchor)) {
          this.prepareAnchor(anchor);
        }
      }
    });
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
    this.subtreeObserver.observe(this, { childList: true, subtree: true });
    for (const anchor of this.querySelectorAll<HTMLAnchorElement>(SESSION_LINK_SELECTOR)) {
      this.prepareAnchor(anchor);
    }
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.handleKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.subtreeObserver.disconnect();
    if (this.scanAnimationFrame !== null) {
      cancelAnimationFrame(this.scanAnimationFrame);
      this.scanAnimationFrame = null;
    }
    this.pendingAnchors.clear();
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

  private mainKey(): string {
    const context = this.context;
    return context
      ? resolveUiConfiguredMainKey({
          agentsList: context.agents.state.agentsList,
          hello: context.gateway.snapshot.hello,
        })
      : "main";
  }

  private resolveShortTarget(target: Extract<SessionPathTarget, { kind: "short" }>): string | null {
    const rows = this.context?.sessions.state.result?.sessions ?? [];
    for (const row of rows) {
      const parsed = parseAgentSessionKey(row.key);
      const uuid = sessionKeyUuid(row.key);
      if (
        parsed &&
        normalizeAgentId(parsed.agentId) === normalizeAgentId(target.agentId) &&
        uuid?.startsWith(target.shortId.toLowerCase().replaceAll("-", "")) &&
        (!target.slugHint || controlUiSessionSlug(row.displayName) === target.slugHint)
      ) {
        return row.key;
      }
    }
    // A short ref is not a canonical key. V1 deliberately avoids a resolve RPC
    // on hover; only the already-loaded session roster may make it previewable.
    return null;
  }

  private targetForAnchor(anchor: HTMLAnchorElement): SessionPreviewTarget | null {
    const rawKey = anchor.dataset.sessionKey?.trim();
    if (rawKey) {
      const parsed = parseAgentSessionKey(rawKey);
      return parsed ? { sessionKey: rawKey, agentId: parsed.agentId, namespace: "chat" } : null;
    }
    let url: URL;
    try {
      url = new URL(anchor.href, globalThis.location?.href ?? "http://localhost/");
    } catch {
      return null;
    }
    if (url.origin !== globalThis.location?.origin) {
      return null;
    }
    const target = sessionRefFromPath(url.pathname, this.context?.basePath ?? "", this.mainKey());
    if (!target) {
      return null;
    }
    const sessionKey =
      target.kind === "main"
        ? buildAgentMainSessionKey({ agentId: target.agentId, mainKey: this.mainKey() })
        : target.kind === "literal"
          ? target.sessionKey
          : this.resolveShortTarget(target);
    return sessionKey ? { sessionKey, agentId: target.agentId, namespace: target.namespace } : null;
  }

  private findSeedRow(target: SessionPreviewTarget): GatewaySessionRow | undefined {
    return this.context?.sessions.state.result?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, target.sessionKey),
    );
  }

  private setCacheEntry(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) {
        break;
      }
      this.cache.delete(oldest);
    }
  }

  private loadPreview(target: SessionPreviewTarget): Promise<SessionPreview> {
    const key = target.sessionKey;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.setCacheEntry(key, cached);
      return cached.promise;
    }
    if (cached) {
      this.cache.delete(key);
    }
    const seeded = this.findSeedRow(target);
    if (seeded) {
      const value = previewFromRow(seeded, target);
      const entry = { expiresAt: now + SUCCESS_CACHE_MS, promise: Promise.resolve(value), value };
      this.setCacheEntry(key, entry);
      return entry.promise;
    }

    const load = async () => {
      if (!this.client) {
        throw new Error("Session preview requires a connected Gateway");
      }
      return parsePreviewResponse(
        await this.client.request<ControlUiSessionPreview>("controlUi.sessionPreview", {
          sessionKey: target.sessionKey,
        }),
      );
    };
    const entry: CacheEntry = {
      expiresAt: now + SUCCESS_CACHE_MS,
      promise: Promise.resolve().then(load),
    };
    entry.promise = entry.promise.then(
      (value) => {
        entry.value = value;
        return value;
      },
      (error: unknown) => {
        entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
        throw error;
      },
    );
    this.setCacheEntry(key, entry);
    return entry.promise;
  }

  private stampAnchor(
    anchor: HTMLAnchorElement,
    target: SessionPreviewTarget | null,
    preview?: SessionPreview,
  ): void {
    if (!target) {
      return;
    }
    const title = preview ? displayTitle(preview) : undefined;
    const href = pathForSession(
      target.namespace,
      target.agentId,
      target.sessionKey,
      this.context?.basePath,
      {
        displayName: title,
        mainKey: this.mainKey(),
      },
    );
    if (href && anchor.getAttribute("href") !== href) {
      anchor.setAttribute("href", href);
    }
    if (!title || anchor.classList.contains("markdown-session-link--titled")) {
      return;
    }
    anchor.classList.add("markdown-session-link--titled");
    anchor.textContent = title;
    anchor.title = target.sessionKey;
  }

  private prepareAnchor(anchor: HTMLAnchorElement): void {
    const target = this.targetForAnchor(anchor);
    if (!target) {
      return;
    }
    const promise = this.loadPreview(target);
    this.stampAnchor(anchor, target, this.cache.get(target.sessionKey)?.value);
    void promise.then(
      (preview) => {
        if (anchor.isConnected && anchor.dataset.sessionKey === target.sessionKey) {
          this.stampAnchor(anchor, target, preview);
        }
      },
      () => undefined,
    );
  }

  private readonly handlePointerOver = (event: Event) => {
    if ("pointerType" in event && event.pointerType === "touch") {
      return;
    }
    const anchor = sessionLinkAnchorFromEvent(event);
    const target = anchor ? this.targetForAnchor(anchor) : null;
    if (anchor && target) {
      this.activateFromBootstrap(anchor, "pointer", SESSION_HOVERCARD_OPEN_DELAY_MS);
    }
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const anchor = sessionLinkAnchorFromEvent(event);
    if (!anchor || anchor !== this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
      return;
    }
    this.pointerInside = false;
    this.scheduleClose();
  };

  private readonly handleFocusIn = (event: Event) => {
    const anchor = sessionLinkAnchorFromEvent(event);
    const target = anchor ? this.targetForAnchor(anchor) : null;
    if (anchor && target) {
      this.activateFromBootstrap(anchor, "focus", 0);
    }
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (
      this.activeAnchor &&
      !(event.relatedTarget instanceof Node && this.activeAnchor.contains(event.relatedTarget))
    ) {
      this.focusInside = false;
      this.scheduleClose();
    }
  };

  private readonly handleCardPointerEnter = () => {
    this.pointerOverCard = true;
    this.clearCloseTimer();
  };

  private readonly handleCardPointerLeave = () => {
    this.pointerOverCard = false;
    this.scheduleClose();
  };

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
    trigger: "focus" | "pointer",
    delay: number,
  ): void {
    const target = this.targetForAnchor(anchor);
    if (!target) {
      return;
    }
    if (anchor === this.activeAnchor && this.activeTarget?.sessionKey === target.sessionKey) {
      return;
    }
    this.close();
    this.activeAnchor = anchor;
    this.activeTarget = target;
    anchor.setAttribute("aria-haspopup", "dialog");
    anchor.setAttribute("aria-expanded", "false");
    if (trigger === "pointer") {
      this.pointerInside = true;
    } else {
      this.focusInside = true;
    }
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      this.show(anchor, target);
    }, delay);
  }

  private show(anchor: HTMLAnchorElement, target: SessionPreviewTarget): void {
    if (this.activeAnchor !== anchor || this.activeTarget?.sessionKey !== target.sessionKey) {
      return;
    }
    const card = document.createElement("div");
    nextHovercardId += 1;
    card.id = `openclaw-session-hovercard-${nextHovercardId}`;
    card.className = "session-link-hovercard";
    card.dataset.open = "true";
    card.setAttribute("role", "dialog");
    this.renderedPreview = null;
    this.renderedUnavailable = false;
    renderLoading(card);
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    document.body.append(card);
    this.card = card;
    anchor.setAttribute("aria-controls", card.id);
    anchor.setAttribute("aria-expanded", "true");
    this.listenForViewportChanges();
    this.positionCard();
    void this.previewTask.run([target]);
  }

  private get hoverIntentHeld(): boolean {
    return this.pointerInside || this.pointerOverCard || this.focusInside;
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private scheduleClose(): void {
    this.clearCloseTimer();
    if (this.hoverIntentHeld) {
      return;
    }
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

  private close(): void {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.clearCloseTimer();
    void this.previewTask.run([null]);
    if (this.activeAnchor) {
      this.activeAnchor.removeAttribute("aria-controls");
      this.activeAnchor.removeAttribute("aria-expanded");
      this.activeAnchor.removeAttribute("aria-haspopup");
    }
    this.card?.remove();
    this.card = null;
    this.renderedPreview = null;
    this.renderedUnavailable = false;
    this.activeAnchor = null;
    this.activeTarget = null;
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
