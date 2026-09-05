import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { controlUiSessionSlug } from "@openclaw/session-url-contract";
import type { ControlUiSessionPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import { sessionRefFromPath, type SessionPathTarget } from "../app-session-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { sessionKeyUuid } from "../pages/chat/route-loader-short-cache.ts";

const SESSION_LINK_SELECTOR = "a.markdown-session-link";
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

function titleFromRow(row: GatewaySessionRow, target: SessionTitleTarget): SessionTitle {
  return {
    ...target,
    sessionKey: row.key,
    agentId: row.agentId ?? parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
    title: row.displayName ?? row.derivedTitle,
  };
}

export class SessionLinkTitler {
  client: GatewayBrowserClient | null = null;
  context: ApplicationContext | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (node instanceof HTMLAnchorElement && node.matches(SESSION_LINK_SELECTOR)) {
          void this.decorate(node);
        }
        for (const anchor of node.querySelectorAll<HTMLAnchorElement>(SESSION_LINK_SELECTOR)) {
          void this.decorate(anchor);
        }
      }
    }
  });

  constructor(private readonly host: HTMLElement) {}

  connect(): void {
    this.observer.observe(this.host, { childList: true, subtree: true });
    this.refresh();
  }

  refresh(): void {
    for (const anchor of this.host.querySelectorAll<HTMLAnchorElement>(SESSION_LINK_SELECTOR)) {
      void this.decorate(anchor);
    }
  }

  disconnect(): void {
    this.observer.disconnect();
  }

  async decorate(anchor: HTMLAnchorElement, load = false): Promise<void> {
    const target = this.targetForAnchor(anchor);
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
    // Short refs are ambiguous without the loaded roster, so they never reach the preview RPC.
    return null;
  }

  private targetForAnchor(anchor: HTMLAnchorElement): SessionTitleTarget | null {
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

  private findSeedRow(target: SessionTitleTarget): GatewaySessionRow | undefined {
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

  private cachedOrSeededEntry(target: SessionTitleTarget): CacheEntry | undefined {
    const now = Date.now();
    const cached = this.cache.get(target.sessionKey);
    if (cached && cached.expiresAt > now) {
      this.setCacheEntry(target.sessionKey, cached);
      return cached;
    }
    if (cached) {
      this.cache.delete(target.sessionKey);
    }
    const row = this.findSeedRow(target);
    if (!row) {
      return undefined;
    }
    const value = titleFromRow(row, target);
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
}
