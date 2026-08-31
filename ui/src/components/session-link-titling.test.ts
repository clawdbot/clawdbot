/* @vitest-environment jsdom */

import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { setSessionPathBuilder } from "../app-session-path-builder.ts";
import type { ApplicationContext } from "../app/context.ts";
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
    setSessionPathBuilder(buildControlUiSessionPath);
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
});
