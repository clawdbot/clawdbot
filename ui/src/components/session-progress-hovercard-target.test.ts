/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { sessionProgressHoverTargetFromEvent } from "./session-progress-hovercard-target.ts";
import { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.ts";

if (!customElements.get("openclaw-session-progress-hovercard-provider")) {
  customElements.define(
    "openclaw-session-progress-hovercard-provider",
    SessionProgressHovercardProvider,
  );
}

function mountHovercard(sessionKey = "global", holdProgress = false) {
  let selectedId = "research";
  const selectionListeners = new Set<() => void>();
  const eventListeners = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  let releaseProgress: (() => void) | undefined;
  const request = vi.fn(
    async (
      method: string,
      params: { sessionKey?: string; sessionKeys?: string[]; agentId?: string },
    ) => {
      if (method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) {
        return { sessions: {} };
      }
      if (method !== "progressCard.get") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const ownerAtRequest = params.agentId ?? params.sessionKey?.split(":")[1];
      if (holdProgress && ownerAtRequest === "research") {
        await new Promise<void>((resolve) => {
          releaseProgress = resolve;
        });
      }
      return {
        card: {
          sessionKey: params.sessionKey?.startsWith("agent:")
            ? params.sessionKey
            : `agent:${params.agentId}:${params.sessionKey}`,
          revision: 1,
          updatedAt: 1,
          markdown: `${ownerAtRequest} progress`,
        },
      };
    },
  );
  const gateway = {
    snapshot: {
      phase: "connected",
      assistantAgentId: "main",
      client: { request },
      hello: {
        features: {
          methods: ["progressCard.get", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
        },
      },
    },
    connection: { token: "", password: "" },
    subscribe: () => () => undefined,
    subscribeEvents: (listener: Parameters<ApplicationGateway["subscribeEvents"]>[0]) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  const context = {
    gateway,
    basePath: "",
    sessions: { subscribe: () => () => undefined },
    agentSelection: {
      get state() {
        return { selectedId, scopeId: selectedId };
      },
      subscribe: (listener: () => void) => {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext;
  const provider = document.createElement(
    "openclaw-session-progress-hovercard-provider",
  ) as SessionProgressHovercardProvider;
  provider.context = context;
  provider.gateway = gateway;
  const sidebar = Object.assign(document.createElement("openclaw-app-sidebar"), {
    expandedAgentId: () => selectedId,
    findSidebarHovercardRowByKey: () => ({
      key: sessionKey,
      agentId: selectedId,
      label: `${selectedId} session`,
      kind: "direct",
    }),
  });
  const row = document.createElement("div");
  row.className = "sidebar-recent-session";
  row.dataset.sessionKey = sessionKey;
  const trigger = document.createElement("a");
  trigger.className = "sidebar-recent-session__link";
  trigger.href = "#";
  trigger.textContent = "Session";
  row.append(trigger);
  sidebar.append(row);
  provider.append(sidebar);
  document.body.append(provider);
  return {
    gateway,
    request,
    emitProgressChange: () => {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event: "progressCard.changed",
          payload: { sessionKey, revision: 2 },
        });
      }
    },
    focus: () =>
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true })),
    selectMain: () => {
      selectedId = "main";
      for (const listener of selectionListeners) {
        listener();
      }
    },
    releaseProgress: async () => {
      releaseProgress?.();
      await Promise.all(request.mock.results.map((result) => result.value));
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sessionProgressHoverTargetFromEvent", () => {
  it.each([
    ["a chat link", "a", "markdown-session-link"],
    ["a sidebar row", "div", "sidebar-recent-session"],
  ])("matches %s", (_label, tagName, className) => {
    const host = document.body.appendChild(document.createElement("div"));
    const target = host.appendChild(document.createElement(tagName));
    target.className = className;
    target.dataset.sessionKey = "agent:main:other-session";
    const child = target.appendChild(document.createElement("span"));
    let matched: HTMLElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverTargetFromEvent(event);
    });

    child.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));

    expect(matched).toBe(target);
  });

  it("ignores unrelated data carriers", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const candidate = host.appendChild(document.createElement("button"));
    candidate.className = "custom-session-control";
    candidate.dataset.sessionKey = "agent:main:other-session";
    let matched: HTMLElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverTargetFromEvent(event);
    });

    candidate.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));

    expect(matched).toBeNull();
  });

  it("ignores touch pointer events", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const row = host.appendChild(document.createElement("div"));
    row.className = "sidebar-recent-session";
    row.dataset.sessionKey = "agent:main:other-session";
    let matched: HTMLElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverTargetFromEvent(event);
    });

    row.dispatchEvent(
      new PointerEvent("pointerover", {
        bubbles: true,
        composed: true,
        pointerType: "touch",
      }),
    );

    expect(matched).toBeNull();
  });
});

describe("session progress hovercard ownership", () => {
  it.each([true, false])(
    "removes denied progress from a held hovercard while retaining transient failures (denied: %s)",
    async (denied) => {
      const sessionKey = "agent:research:main";
      const harness = mountHovercard(sessionKey);
      harness.focus();
      const portalText = () =>
        document.querySelector(".session-progress-hovercard")?.textContent ?? "";
      await vi.waitFor(() => expect(portalText()).toContain("research progress"));
      const error = denied
        ? new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Participation required",
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          })
        : new Error("Temporary connection failure");
      harness.request.mockRejectedValueOnce(error);
      harness.emitProgressChange();
      await vi.waitFor(() =>
        expect(sessionProgressCardsForGateway(harness.gateway).getError({ sessionKey })).toBe(
          denied ? "access-denied" : "unavailable",
        ),
      );
      expect(portalText()).toContain("research session");
      if (denied) {
        expect(portalText()).not.toContain("research progress");
      } else {
        expect(portalText()).toContain("research progress");
      }
    },
  );

  it.each([
    ["global", "agent:research:global", "research"],
    ["agent:other:main", "agent:other:main", "other"],
  ])(
    "uses the hovered session owner for progress and PR data: %s",
    async (sessionKey, artifactKey, agentId) => {
      const harness = mountHovercard(sessionKey);
      harness.focus();
      await vi.waitFor(() =>
        expect(harness.request).toHaveBeenCalledWith("progressCard.get", {
          sessionKey,
          ...(sessionKey === "global" ? { agentId } : {}),
        }),
      );
      await vi.waitFor(() =>
        expect(harness.request).toHaveBeenCalledWith(
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          expect.objectContaining({ sessionKeys: [artifactKey] }),
        ),
      );
      expect(document.querySelector(".session-progress-hovercard")?.textContent).toContain(
        `${agentId} progress`,
      );
    },
  );

  it("retires an in-flight global hover when the sidebar owner changes", async () => {
    const harness = mountHovercard("global", true);
    harness.focus();
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith("progressCard.get", expect.anything()),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".session-progress-hovercard")?.textContent).toContain(
        "research session",
      ),
    );
    harness.selectMain();
    expect(document.querySelector(".session-progress-hovercard")).toBeNull();
    harness.focus();
    await vi.waitFor(() =>
      expect(document.querySelector(".session-progress-hovercard")?.textContent).toContain(
        "main progress",
      ),
    );
    await harness.releaseProgress();
    await vi.waitFor(() =>
      expect(document.querySelector(".session-progress-hovercard")?.textContent).not.toContain(
        "research progress",
      ),
    );
    expect(harness.request).toHaveBeenCalledWith("progressCard.get", {
      sessionKey: "global",
      agentId: "main",
    });
  });
});
