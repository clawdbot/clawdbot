/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../types.ts";
import {
  getContextNoticeViewModel,
  renderContextNotice,
  resetContextNoticeThemeCacheForTest,
} from "./context-notice.ts";
import { renderChatRunControls, type ChatRunControlsProps } from "./run-controls.ts";
import { renderSideResult } from "./side-result-render.ts";
import { renderCompactionIndicator, renderFallbackIndicator } from "./status-indicators.ts";

vi.mock("../icons.ts", () => ({
  icons: {},
}));

vi.mock("../markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

function createProps(overrides: Partial<ChatRunControlsProps> = {}): ChatRunControlsProps {
  return {
    canAbort: false,
    connected: true,
    draft: "",
    hasMessages: false,
    isBusy: false,
    sending: false,
    onAbort: () => undefined,
    onExport: () => undefined,
    onNewSession: () => undefined,
    onSend: () => undefined,
    onStoreDraft: () => undefined,
    ...overrides,
  };
}

describe("chat run controls", () => {
  it("switches between idle and abort actions", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    const onQueueSend = vi.fn();
    const onQueueStoreDraft = vi.fn();
    render(
      renderChatRunControls(
        createProps({
          canAbort: true,
          draft: " queue this ",
          sending: true,
          onAbort,
          onSend: onQueueSend,
          onStoreDraft: onQueueStoreDraft,
        }),
      ),
      container,
    );

    const queueButton = container.querySelector<HTMLButtonElement>('button[title="Queue"]');
    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(queueButton).not.toBeNull();
    expect(queueButton?.disabled).toBe(true);
    expect(stopButton).not.toBeNull();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");

    const onNewSession = vi.fn();
    const onSend = vi.fn();
    const onStoreDraft = vi.fn();
    render(
      renderChatRunControls(
        createProps({
          draft: " run this ",
          hasMessages: true,
          onNewSession,
          onSend,
          onStoreDraft,
        }),
      ),
      container,
    );

    const newSessionButton = container.querySelector<HTMLButtonElement>(
      'button[title="New session"]',
    );
    expect(newSessionButton).not.toBeNull();
    newSessionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);

    const sendButton = container.querySelector<HTMLButtonElement>('button[title="Send"]');
    expect(sendButton).not.toBeNull();
    sendButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onStoreDraft).toHaveBeenCalledWith(" run this ");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Stop");
  });

  it("queues draft text while an active run is abortable", () => {
    const container = document.createElement("div");
    const onSend = vi.fn();
    const onStoreDraft = vi.fn();
    render(
      renderChatRunControls(
        createProps({
          canAbort: true,
          draft: " follow up ",
          onSend,
          onStoreDraft,
        }),
      ),
      container,
    );

    const queueButton = container.querySelector<HTMLButtonElement>('button[title="Queue"]');
    expect(queueButton).not.toBeNull();
    expect(queueButton?.disabled).toBe(false);
    queueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onStoreDraft).toHaveBeenCalledWith(" follow up ");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps Stop clickable while disconnected when a run is abortable", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(
      renderChatRunControls(
        createProps({
          canAbort: true,
          connected: false,
          onAbort,
        }),
      ),
      container,
    );

    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeNull();
    expect(stopButton?.disabled).toBe(false);
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

describe("chat status indicators", () => {
  it("renders compaction and fallback indicators while they are fresh", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now");
    const renderIndicators = (
      compactionStatus: Parameters<typeof renderCompactionIndicator>[0],
      fallbackStatus: Parameters<typeof renderFallbackIndicator>[0],
    ) => {
      render(
        html`${renderFallbackIndicator(fallbackStatus)}
        ${renderCompactionIndicator(compactionStatus)}`,
        container,
      );
    };

    try {
      nowSpy.mockReturnValue(1_000);
      renderIndicators(
        {
          phase: "active",
          runId: "run-1",
          startedAt: 1_000,
          completedAt: null,
        },
        {
          selected: "fireworks/minimax-m2p5",
          active: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: ["fireworks/minimax-m2p5: rate limit"],
          occurredAt: 900,
        },
      );

      let indicator = container.querySelector(".compaction-indicator--active");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Compacting context...");
      indicator = container.querySelector(".compaction-indicator--fallback");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");

      renderIndicators(
        {
          phase: "complete",
          runId: "run-1",
          startedAt: 900,
          completedAt: 900,
        },
        {
          phase: "cleared",
          selected: "fireworks/minimax-m2p5",
          active: "fireworks/minimax-m2p5",
          previous: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: [],
          occurredAt: 900,
        },
      );
      indicator = container.querySelector(".compaction-indicator--complete");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Context compacted");
      indicator = container.querySelector(".compaction-indicator--fallback-cleared");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");

      nowSpy.mockReturnValue(20_000);
      renderIndicators(
        {
          phase: "complete",
          runId: "run-1",
          startedAt: 0,
          completedAt: 0,
        },
        {
          selected: "fireworks/minimax-m2p5",
          active: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: [],
          occurredAt: 0,
        },
      );
      expect(container.querySelector(".compaction-indicator--fallback")).toBeNull();
      expect(container.querySelector(".compaction-indicator--complete")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("context notice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetContextNoticeThemeCacheForTest();
  });

  it("renders only for fresh high current usage", () => {
    const container = document.createElement("div");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) =>
        name === "--warn" ? "#010203" : name === "--danger" ? "#040506" : "",
    } as CSSStyleDeclaration);
    resetContextNoticeThemeCacheForTest();

    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 757_300,
          totalTokens: 46_000,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();

    const session: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      inputTokens: 757_300,
      totalTokens: 190_000,
      contextTokens: 200_000,
    };
    render(renderContextNotice(session, 200_000), container);

    expect(container.textContent).toContain("95% context used");
    expect(container.textContent).toContain("190k / 200k");
    expect(getContextNoticeViewModel(session, 200_000)?.compactRecommended).toBe(true);
    expect(container.textContent).not.toContain("757.3k / 200k");
    const notice = container.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.style.getPropertyValue("--ctx-color")).toContain("rgb(");
    expect(notice?.style.getPropertyValue("--ctx-color")).toContain("4, 5, 6");
    expect(notice?.style.getPropertyValue("--ctx-color")).not.toContain("NaN");
    expect(notice?.style.getPropertyValue("--ctx-bg")).not.toContain("NaN");

    const icon = container.querySelector<SVGElement>(".context-notice__icon");
    expect(icon).not.toBeNull();
    expect(icon?.tagName.toLowerCase()).toBe("svg");
    expect(icon?.classList.contains("context-notice__icon")).toBe(true);
    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.querySelector("path")).not.toBeNull();

    const onCompact = vi.fn();
    render(renderContextNotice(session, 200_000, { onCompact }), container);
    expect(container.textContent).toContain("Compact");
    container.querySelector<HTMLButtonElement>(".context-notice__action")?.click();
    expect(onCompact).toHaveBeenCalledTimes(1);

    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 500_000,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();
    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          totalTokens: 190_000,
          totalTokensFresh: false,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();
  });
});

describe("side result render", () => {
  it("renders, dismisses, and styles BTW side results outside transcript history", () => {
    const container = document.createElement("div");
    const onDismissSideResult = vi.fn();

    render(
      renderSideResult(
        {
          kind: "btw",
          runId: "btw-run-1",
          sessionKey: "main",
          question: "what changed?",
          text: "The web UI now renders **BTW** separately.",
          isError: false,
          ts: 2,
        },
        onDismissSideResult,
      ),
      container,
    );

    expect(container.querySelector(".chat-side-result")).not.toBeNull();
    expect(container.textContent).toContain("BTW");
    expect(container.textContent).toContain("what changed?");
    expect(container.textContent).toContain("Not saved to chat history");
    expect(container.querySelectorAll(".chat-side-result")).toHaveLength(1);

    const button = container.querySelector<HTMLButtonElement>(".chat-side-result__dismiss");
    expect(button).not.toBeNull();
    button?.click();
    expect(onDismissSideResult).toHaveBeenCalledTimes(1);

    render(
      renderSideResult({
        kind: "btw",
        runId: "btw-run-3",
        sessionKey: "main",
        question: "what failed?",
        text: "The side question could not be answered.",
        isError: true,
        ts: 4,
      }),
      container,
    );

    expect(container.querySelector(".chat-side-result--error")).not.toBeNull();
  });
});
