/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";

const SESSION_KEY = "agent:main:research";

function sessionContext(rows: GatewaySessionRow[] = []): ApplicationContext {
  return {
    basePath: "",
    sessions: { state: { result: { count: rows.length, sessions: rows } } },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: { snapshot: { hello: null } },
  } as unknown as ApplicationContext;
}

function sessionAnchor(sessionKey = SESSION_KEY): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "markdown-session-link";
  anchor.dataset.sessionKey = sessionKey;
  anchor.textContent = sessionKey;
  return anchor;
}

function previewResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    sessionKey: SESSION_KEY,
    title: "Research plan",
    agentId: "main",
    ...overrides,
  };
}

function createTitler(rows: GatewaySessionRow[] = [], request = vi.fn()) {
  const host = document.createElement("div");
  const titler = new SessionLinkTitler(host);
  titler.client = { request } as unknown as GatewayBrowserClient;
  titler.context = sessionContext(rows);
  return { host, request, titler };
}

describe("SessionLinkTitler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("seeds a titled link and canonical href from the loaded session roster", async () => {
    const row = {
      key: SESSION_KEY,
      agentId: "main",
      kind: "direct",
      displayName: "Cached research",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const { request, titler } = createTitler([row]);
    const anchor = sessionAnchor();

    await titler.decorate(anchor);

    expect(anchor.textContent).toBe("Cached research");
    expect(anchor.classList.contains("markdown-session-link--titled")).toBe(true);
    expect(anchor.title).toBe(SESSION_KEY);
    expect(anchor.getAttribute("href")).toBe("/chat/main/research");
    expect(request).not.toHaveBeenCalled();
  });

  it("loads an unseeded title from the preview RPC and reuses its cache", async () => {
    const request = vi.fn().mockResolvedValue(previewResponse());
    const { titler } = createTitler([], request);
    const first = sessionAnchor();
    const second = sessionAnchor();

    await titler.decorate(first, true);
    await titler.decorate(second, true);

    expect(first.textContent).toBe("Research plan");
    expect(second.textContent).toBe("Research plan");
    expect(first.getAttribute("href")).toBe("/chat/main/research");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("controlUi.sessionPreview", { sessionKey: SESSION_KEY });
  });

  it("expires successful and failed cache entries at their separate TTLs", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(previewResponse({ title: undefined }))
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce(previewResponse());
    const { titler } = createTitler([], request);

    await titler.decorate(sessionAnchor(), true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await titler.decorate(sessionAnchor(), true);
    await titler.decorate(sessionAnchor(), true);
    expect(request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await titler.decorate(sessionAnchor(), true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("resolves short references only from the loaded roster", async () => {
    const sessionKey = "agent:main:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
    const row = {
      key: sessionKey,
      agentId: "main",
      kind: "direct",
      displayName: "Research plan",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const request = vi.fn().mockResolvedValue(previewResponse());
    const unseeded = createTitler([], request).titler;
    const unseededAnchor = document.createElement("a");
    unseededAnchor.className = "markdown-session-link";
    unseededAnchor.href = "/chat/main/research-plan-2139bddb";

    await unseeded.decorate(unseededAnchor, true);
    expect(request).not.toHaveBeenCalled();

    const seeded = createTitler([row], request).titler;
    const seededAnchor = unseededAnchor.cloneNode() as HTMLAnchorElement;
    await seeded.decorate(seededAnchor, true);
    expect(seededAnchor.textContent).toBe("Research plan");
    expect(seededAnchor.title).toBe(sessionKey);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ["bare URL", `${location.origin}/chat/main/d0effac9?view=details#latest`],
    ["relative href", "[Contract](/chat/main/old-name-d0effac9?view=details#latest)"],
    ["slug-only href", "[Contract](/chat/main/shared-contract?view=details#latest)"],
    ["inline code", "`/chat/main/d0effac9?view=details#latest`"],
    ["public URL", "https://chat.example/chat/main/d0effac9?view=details#latest"],
    ["public inline code", "`https://chat.example/chat/main/d0effac9?view=details#latest`"],
  ])(
    "connects %s to the same hover identity without losing route intent",
    async (_kind, markdown) => {
      const key = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
      const row: GatewaySessionRow = {
        key,
        kind: "direct",
        displayName: "Shared contract",
        updatedAt: Date.now(),
      };
      const { host, titler, request } = createTitler([row]);
      titler.context = {
        ...sessionContext([row]),
        runtimeConfig: {
          state: {
            configSnapshot: {
              runtimeConfig: { gateway: { publicOrigin: "https://CHAT.example:443/" } },
            },
          },
        },
      } as unknown as ApplicationContext;
      host.innerHTML = toSanitizedMarkdownHtml(markdown, { sessionLinks: true, fileLinks: true });
      titler.connect();
      await Promise.resolve();
      const link = host.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.dataset.sessionKey).toBe(key);
      expect(link?.textContent).toBe("Shared contract");
      expect(link?.getAttribute("href")).toMatch(
        /^\/chat\/main\/(?:.*d0effac9|shared-contract)\?view=details#latest$/,
      );
      expect(link?.hasAttribute("target")).toBe(false);
      expect(request).not.toHaveBeenCalled();
      titler.disconnect();
    },
  );

  it("keeps unknown and ambiguous URLs navigable without a hover identity, then refreshes a known row", () => {
    const key = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
    const rows: GatewaySessionRow[] = [];
    const { host, titler, request } = createTitler(rows);
    host.innerHTML = toSanitizedMarkdownHtml("[Contract](/chat/main/d0effac9)", {
      sessionLinks: true,
    });
    titler.refresh();
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    expect(link.dataset.sessionKey).toBeUndefined();
    expect(link.getAttribute("href")).toBe("/chat/main/d0effac9");
    rows.push({ key, kind: "direct", displayName: "Shared contract", updatedAt: Date.now() });
    titler.refresh();
    expect(link.dataset.sessionKey).toBe(key);
    rows.push({ key: key.replace("3211", "4322"), kind: "direct", updatedAt: Date.now() });
    titler.refresh();
    expect(link.dataset.sessionKey).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves remote links and code spans plain", () => {
    const { host, titler } = createTitler();
    host.innerHTML = toSanitizedMarkdownHtml(
      "[Remote](https://elsewhere.example/chat/main/d0effac9) `https://elsewhere.example/chat/main/d0effac9`",
      { sessionLinks: true },
    );
    titler.refresh();
    expect(host.querySelector(".markdown-session-link")).toBeNull();
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.target).toBe("_blank");
    expect(host.querySelector("code")?.parentElement?.tagName).not.toBe("A");
  });
});
