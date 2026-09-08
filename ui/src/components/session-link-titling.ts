import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { ControlUiSessionPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { findLocalSessionReference } from "../pages/chat/route-loader-short-cache.ts";
import { markdownSessionPublicOrigin, parseMarkdownSessionUrl } from "./markdown-session-links.ts";

const SESSION_LINK_SELECTOR = "a.markdown-session-link, [data-session-href]";
const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

type SessionTitleTarget = {
  sessionKey: string;
  agentId: string;
  namespace: "chat" | "dashboard";
};

type SessionTitle = SessionTitleTarget & { title?: string };

type CacheEntry = {
  expiresAt: number;
  promise: Promise<SessionTitle>;
  value?: SessionTitle;
};

function titleFromPreview(value: unknown): SessionTitle {
  if (!isRecord(value) || value.status !== "ok") {
    throw new Error("Session title unavailable");
  }
  const sessionKey = readNonBlankString(value.sessionKey);
  const agentId = readNonBlankString(value.agentId);
  if (!sessionKey || !agentId) {
    throw new Error("Session title response was incomplete");
  }
  return {
    sessionKey,
    agentId,
    namespace: "chat",
    title: readNonBlankString(value.title) ?? readNonBlankString(value.derivedTitle),
  };
}

export class SessionLinkTitler {
  client: GatewayBrowserClient | null = null;
  context: ApplicationContext | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly observer = new MutationObserver((records) => {
    for (const node of records.flatMap((record) => [...record.addedNodes])) {
      if (node instanceof HTMLElement) {
        this.refresh(node);
      }
    }
  });

  constructor(private readonly host: HTMLElement) {}

  connect(): void {
    this.observer.observe(this.host, { childList: true, subtree: true });
    this.refresh();
  }

  refresh(root = this.host): void {
    if (root.matches(SESSION_LINK_SELECTOR)) {
      void this.decorate(root);
    }
    for (const anchor of root.querySelectorAll<HTMLElement>(SESSION_LINK_SELECTOR)) {
      void this.decorate(anchor);
    }
  }

  disconnect(): void {
    this.observer.disconnect();
  }

  async decorate(element: HTMLElement, load = false): Promise<void> {
    const target = this.targetForAnchor(element);
    const anchor = element instanceof HTMLAnchorElement ? element : document.createElement("a");
    if (element !== anchor && element.classList.contains("markdown-session-link")) {
      anchor.dataset.sessionHref = element.dataset.sessionHref;
      anchor.setAttribute("href", element.getAttribute("href") ?? "");
      anchor.className = "markdown-session-link";
      element.classList.remove("markdown-session-link");
      element.removeAttribute("href");
      element.removeAttribute("data-session-href");
      element.replaceWith(anchor);
      anchor.append(element);
    }
    if (!target) {
      return;
    }
    const cached = this.cachedOrSeededEntry(target);
    this.stampAnchor(anchor, target, cached?.value);
    if (!load || cached?.value) {
      return;
    }
    try {
      this.stampAnchor(anchor, target, await this.loadTitle(target));
    } catch {
      // A title is decoration; the session link remains usable with its raw key.
    }
  }

  private mainKey(): string {
    return resolveUiConfiguredMainKey({
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  private targetForAnchor(anchor: HTMLElement): SessionTitleTarget | null {
    const rawKey = anchor.dataset.sessionKey?.trim();
    if (rawKey && !anchor.dataset.sessionHref) {
      const parsed = parseAgentSessionKey(rawKey);
      return parsed ? { sessionKey: rawKey, agentId: parsed.agentId, namespace: "chat" } : null;
    }
    const path = parseMarkdownSessionUrl(
      anchor.dataset.sessionHref ?? anchor.getAttribute("href") ?? "",
      this.context?.basePath,
      this.mainKey(),
    );
    if (
      !path ||
      (path.url.origin !== globalThis.location.origin &&
        path.url.origin !== markdownSessionPublicOrigin(this.context))
    ) {
      return null;
    }
    // Keep URL route intent (face, query, fragment) even when its identity is cached.
    anchor.setAttribute("href", `${path.url.pathname}${path.url.search}${path.url.hash}`);
    anchor.classList.add("markdown-session-link");
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    anchor.removeAttribute("data-session-key");
    const row = findLocalSessionReference(
      this.context?.sessions.state.result?.sessions ?? [],
      path.target,
      this.mainKey(),
    );
    return row
      ? { sessionKey: row.key, agentId: path.target.agentId, namespace: path.target.namespace }
      : null;
  }

  private setCacheEntry(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= CACHE_LIMIT) {
        break;
      }
      this.cache.delete(oldest);
    }
  }

  private cachedOrSeededEntry(target: SessionTitleTarget): CacheEntry | undefined {
    const now = Date.now();
    const cached = this.cache.get(target.sessionKey);
    if (cached && cached.expiresAt > now) {
      this.setCacheEntry(target.sessionKey, cached);
      return cached;
    }
    this.cache.delete(target.sessionKey);
    const row = this.context?.sessions.state.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, target.sessionKey),
    );
    if (!row) {
      return undefined;
    }
    const value: SessionTitle = {
      ...target,
      sessionKey: row.key,
      agentId: row.agentId ?? parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
      title: row.displayName ?? row.derivedTitle,
    };
    const entry = { expiresAt: now + SUCCESS_CACHE_MS, promise: Promise.resolve(value), value };
    this.setCacheEntry(target.sessionKey, entry);
    return entry;
  }

  private loadTitle(target: SessionTitleTarget): Promise<SessionTitle> {
    const cached = this.cachedOrSeededEntry(target);
    if (cached) {
      return cached.promise;
    }
    const load = async () => {
      if (!this.client) {
        throw new Error("Session title requires a connected Gateway");
      }
      const title = titleFromPreview(
        await this.client.request<ControlUiSessionPreview>("controlUi.sessionPreview", {
          sessionKey: target.sessionKey,
        }),
      );
      return { ...title, namespace: target.namespace };
    };
    const entry: CacheEntry = {
      expiresAt: Date.now() + SUCCESS_CACHE_MS,
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
    this.setCacheEntry(target.sessionKey, entry);
    return entry.promise;
  }

  private stampAnchor(
    anchor: HTMLAnchorElement,
    target: SessionTitleTarget,
    titleRecord?: SessionTitle,
  ): void {
    const title = titleRecord?.title;
    const href = pathForSession(
      target.namespace,
      target.agentId,
      target.sessionKey,
      this.context?.basePath,
      { displayName: title, exactKey: true, mainKey: this.mainKey() },
    );
    anchor.dataset.sessionKey = target.sessionKey;
    anchor.classList.add("markdown-session-link");
    if (!anchor.dataset.sessionHref && href && anchor.getAttribute("href") !== href) {
      anchor.setAttribute("href", href);
    }
    if (!title || anchor.classList.contains("markdown-session-link--titled")) {
      return;
    }
    anchor.classList.add("markdown-session-link--titled");
    anchor.textContent = title;
    anchor.title = target.sessionKey;
  }
}
