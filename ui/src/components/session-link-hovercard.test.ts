/* @vitest-environment jsdom */

import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { setSessionPathBuilder } from "../app-session-path-builder.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { SessionLinkHovercardProvider } from "./session-link-hovercard.runtime.ts";

const ELEMENT_NAME = `test-openclaw-session-link-hovercard-provider-${crypto.randomUUID()}`;
const SESSION_KEY = "agent:main:research";

customElements.define(ELEMENT_NAME, class extends SessionLinkHovercardProvider {});

type ProviderElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  context: ApplicationContext | null;
};

function sessionContext(rows: GatewaySessionRow[] = []): ApplicationContext {
  return {
    basePath: "",
    sessions: {
      state: {
        result: { count: rows.length, sessions: rows },
      },
    },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: { snapshot: { hello: null } },
  } as unknown as ApplicationContext;
}

function createProvider(options: {
  rows?: GatewaySessionRow[];
  response?: unknown;
  request?: ReturnType<typeof vi.fn>;
}) {
  const provider = document.createElement(ELEMENT_NAME) as ProviderElement;
  const request = options.request ?? vi.fn().mockResolvedValue(options.response);
  provider.client = { request } as unknown as GatewayBrowserClient;
  provider.context = sessionContext(options.rows);
  return { provider, request };
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
    kind: "direct",
    channel: "webchat",
    updatedAt: Date.parse("2026-08-16T11:55:00Z"),
    lastMessagePreview: "The rollout notes are ready.",
    archived: false,
    ...overrides,
  };
}

async function flushMutationBatch(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(16);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(16);
}

async function hover(anchor: HTMLAnchorElement): Promise<void> {
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}

describe("openclaw-session-link-hovercard-provider", () => {
  beforeEach(() => {
    setSessionPathBuilder(buildControlUiSessionPath);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("seeds from the loaded session roster and stamps a titled chip synchronously", () => {
    const row = {
      key: SESSION_KEY,
      agentId: "main",
      kind: "direct",
      displayName: "Cached research",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const { provider, request } = createProvider({ rows: [row] });
    const anchor = sessionAnchor();

    provider.append(anchor);
    document.body.append(provider);

    expect(anchor.textContent).toBe("Cached research");
    expect(anchor.classList.contains("markdown-session-link--titled")).toBe(true);
    expect(anchor.title).toBe(SESSION_KEY);
    expect(anchor.getAttribute("href")).toBe("/chat/main/research");
    expect(request).not.toHaveBeenCalled();
  });

  it("stamps single-segment UUID keys with a forced-literal href", () => {
    const uuid = "12345678-90ab-cdef-1234-567890abcdef";
    const sessionKey = `agent:main:${uuid}`;
    const row = {
      key: sessionKey,
      agentId: "main",
      kind: "direct",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const { provider, request } = createProvider({ rows: [row] });
    const anchor = sessionAnchor(sessionKey);

    provider.append(anchor);
    document.body.append(provider);

    expect(anchor.getAttribute("href")).toBe(`/chat/main/~key/${uuid}`);
    expect(request).not.toHaveBeenCalled();
  });

  it("upgrades from the RPC, renders the card, and reuses one cache entry", async () => {
    const { provider, request } = createProvider({ response: previewResponse() });
    const anchor = sessionAnchor();
    provider.append(anchor);
    document.body.append(provider);
    await vi.advanceTimersByTimeAsync(0);

    expect(anchor.textContent).toBe(SESSION_KEY);
    expect(anchor.getAttribute("href")).toBe("/chat/main/research");
    expect(request).not.toHaveBeenCalled();

    await hover(anchor);
    const card = document.querySelector<HTMLElement>(".session-link-hovercard");
    expect(anchor.textContent).toBe("Research plan");
    expect(card?.textContent).toContain("Research plan");
    expect(card?.textContent).toContain("main · direct · webchat");
    expect(card?.textContent).toContain("The rollout notes are ready.");
    expect(card?.textContent).toContain("5m ago");
    expect(request).toHaveBeenCalledWith("controlUi.sessionPreview", { sessionKey: SESSION_KEY });
    expect(request).toHaveBeenCalledTimes(1);

    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    const stamped = anchor.outerHTML;
    const replacement = sessionAnchor();
    anchor.replaceWith(replacement);
    await flushMutationBatch();
    expect(replacement.outerHTML).toBe(stamped);
    replacement.remove();
    provider.append(replacement);
    await flushMutationBatch();
    expect(replacement.outerHTML).toBe(stamped);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("expires successful and failed cache entries at their separate TTLs", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(previewResponse({ title: undefined, derivedTitle: undefined }))
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce(previewResponse());
    const { provider } = createProvider({ request });
    const anchor = sessionAnchor();
    provider.append(anchor);
    document.body.append(provider);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
    expect(anchor.textContent).toBe(SESSION_KEY);
    expect(anchor.getAttribute("href")).toBe("/chat/main/research");

    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".session-link-hovercard")?.textContent).toContain(
      "Session preview unavailable",
    );

    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(2);

    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await vi.advanceTimersByTimeAsync(30_000);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not resolve an uncached short session path through the preview RPC", async () => {
    const { provider, request } = createProvider({ response: previewResponse() });
    const anchor = document.createElement("a");
    anchor.href = "/chat/main/research-1234abcd";
    anchor.textContent = "Research";
    provider.append(anchor);
    document.body.append(provider);

    await hover(anchor);

    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector(".session-link-hovercard")).toBeNull();
  });

  it("does not overlay sidebar session navigation", async () => {
    const { provider, request } = createProvider({ response: previewResponse() });
    const anchor = document.createElement("a");
    anchor.className = "sidebar-recent-session__link";
    anchor.href = "/chat/main/research";
    anchor.textContent = "Research";
    provider.append(anchor);
    document.body.append(provider);

    await hover(anchor);

    expect(document.querySelector(".session-link-hovercard")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves a short session path only from the loaded roster", async () => {
    const sessionKey = "agent:main:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
    const row = {
      key: sessionKey,
      agentId: "main",
      kind: "direct",
      displayName: "Research plan",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const { provider, request } = createProvider({ rows: [row] });
    const anchor = document.createElement("a");
    anchor.href = "/chat/main/research-plan-2139bddb";
    anchor.textContent = "Research";
    provider.append(anchor);
    document.body.append(provider);

    await hover(anchor);

    expect(document.querySelector(".session-link-hovercard")?.textContent).toContain(
      "Research plan",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("shows loading while the RPC is pending and supports focus plus Escape", async () => {
    let resolvePreview: ((value: unknown) => void) | undefined;
    const request = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    const { provider } = createProvider({ request });
    const anchor = sessionAnchor();
    provider.append(anchor);
    document.body.append(provider);

    anchor.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".session-link-hovercard")?.textContent).toContain(
      "Loading session details…",
    );

    resolvePreview?.(previewResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".session-link-hovercard")?.textContent).toContain(
      "Research plan",
    );
    expect(anchor.getAttribute("aria-expanded")).toBe("true");

    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(document.querySelector(".session-link-hovercard")).toBeNull();
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it("defers unseeded preview requests until intent across many attached anchors", async () => {
    const seededKey = "agent:main:seeded";
    const seededRow = {
      key: seededKey,
      agentId: "main",
      kind: "direct",
      displayName: "Seeded session",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const unseededAnchors = Array.from({ length: 50 }, (_, index) =>
      sessionAnchor(`agent:main:unseeded-${index}`),
    );
    const request = vi.fn().mockResolvedValue(
      previewResponse({
        sessionKey: unseededAnchors[0]?.dataset.sessionKey,
        title: "Hovered session",
      }),
    );
    const { provider } = createProvider({ rows: [seededRow], request });
    const seededAnchor = sessionAnchor(seededKey);
    document.body.append(provider);
    provider.append(seededAnchor, ...unseededAnchors);

    await flushMutationBatch();
    expect(request).not.toHaveBeenCalled();
    expect(unseededAnchors.every((anchor) => anchor.hasAttribute("href"))).toBe(true);
    expect(seededAnchor.textContent).toBe("Seeded session");
    expect(seededAnchor.classList.contains("markdown-session-link--titled")).toBe(true);

    const hoveredAnchor = unseededAnchors[0];
    if (!hoveredAnchor) {
      throw new Error("Expected an unseeded session anchor");
    }
    await hover(hoveredAnchor);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("controlUi.sessionPreview", {
      sessionKey: hoveredAnchor.dataset.sessionKey,
    });
    expect(hoveredAnchor.textContent).toBe("Hovered session");
  });
});
