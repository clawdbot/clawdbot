/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, ModelAuthStatusResult } from "../../api/types.ts";
import { i18n, t } from "../../i18n/index.ts";
import {
  getContextNoticeViewModel,
  renderChatRunControls,
  renderChatRunStatusIndicator,
  renderCompactionIndicator,
  renderContextNotice,
  renderFallbackIndicator,
  resetContextNoticeThemeCacheForTest,
  type ChatRunControlsProps,
} from "./components/chat-composer.ts";

vi.mock("../../components/icons.ts", () => ({
  icons: {},
}));

function createProps(overrides: Partial<ChatRunControlsProps> = {}): ChatRunControlsProps {
  return {
    canAbort: false,
    canSend: true,
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

function getButton(container: Element, selector: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button matching ${selector}`);
  }
  return button;
}

describe("chat run controls", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("uses the primary action for voice when empty, send when composed, and stop while recording", () => {
    const container = document.createElement("div");
    const onToggleVoice = vi.fn();
    const emptyProps = {
      ...createProps({ showSecondary: false }),
      onToggleVoice,
    } as ChatRunControlsProps & {
      onToggleVoice: () => void;
    };

    render(renderChatRunControls(emptyProps), container);

    const voiceButton = getButton(container, 'button[aria-label="Start voice input"]');
    expect(
      container.querySelector(`button[aria-label="${t("chat.runControls.sendMessage")}"]`),
    ).toBeNull();
    voiceButton.click();
    expect(onToggleVoice).toHaveBeenCalledTimes(1);

    render(
      renderChatRunControls({
        ...emptyProps,
        draft: "Send this",
      }),
      container,
    );
    expect(getButton(container, `button[aria-label="${t("chat.runControls.sendMessage")}"]`)).toBe(
      container.querySelector(".chat-send-btn"),
    );
    expect(container.querySelector('button[aria-label="Start voice input"]')).toBeNull();

    render(
      renderChatRunControls({
        ...emptyProps,
        voiceActive: true,
      } as ChatRunControlsProps & {
        onToggleVoice: () => void;
        voiceActive: boolean;
      }),
      container,
    );
    const stopVoiceButton = getButton(container, 'button[aria-label="Stop voice input"]');
    expect(stopVoiceButton.classList.contains("chat-send-btn--voice-live")).toBe(true);
    expect(stopVoiceButton.querySelector(".agent-chat__voice-activity")).not.toBeNull();
    stopVoiceButton.click();
    expect(onToggleVoice).toHaveBeenCalledTimes(2);
  });

  it("keeps attachment-only messages on the send action", () => {
    const container = document.createElement("div");
    render(
      renderChatRunControls({
        ...createProps({ showSecondary: false }),
        hasAttachments: true,
        onToggleVoice: () => undefined,
      } as ChatRunControlsProps & {
        hasAttachments: boolean;
        onToggleVoice: () => void;
      }),
      container,
    );

    expect(
      getButton(container, `button[aria-label="${t("chat.runControls.sendMessage")}"]`),
    ).not.toBeNull();
    expect(container.querySelector('button[aria-label="Start voice input"]')).toBeNull();
  });

  it("keeps queued sends available offline while disabling live voice input", () => {
    const container = document.createElement("div");
    const onSend = vi.fn();
    const onToggleVoice = vi.fn();

    render(
      renderChatRunControls(
        createProps({
          connected: false,
          draft: "queue this offline",
          onSend,
          onToggleVoice,
        }),
      ),
      container,
    );

    const sendButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.sendMessage")}"]`,
    );
    expect(sendButton.disabled).toBe(false);
    sendButton.click();
    expect(onSend).toHaveBeenCalledTimes(1);

    render(renderChatRunControls(createProps({ connected: false, onToggleVoice })), container);
    expect(getButton(container, 'button[aria-label="Start voice input"]').disabled).toBe(true);
  });

  it("keeps voice and generation stop actions available when both are active", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    const onToggleVoice = vi.fn();
    render(
      renderChatRunControls(
        createProps({
          canAbort: true,
          onAbort,
          onToggleVoice,
          voiceActive: true,
        }),
      ),
      container,
    );

    const stopVoiceButton = getButton(container, 'button[aria-label="Stop voice input"]');
    const stopGenerationButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.stopGenerating")}"]`,
    );

    // Redesign guard: the two controls must stay visually distinct — a live
    // waveform pill for voice and a single danger stop square for the run.
    expect(stopVoiceButton.classList.contains("chat-send-btn--voice-live")).toBe(true);
    expect(stopVoiceButton.classList.contains("chat-send-btn--stop")).toBe(false);
    expect(stopGenerationButton.classList.contains("chat-send-btn--stop")).toBe(true);
    expect(container.querySelectorAll(".chat-send-btn--stop")).toHaveLength(1);

    stopVoiceButton.click();
    stopGenerationButton.click();
    expect(onToggleVoice).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

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

    const queueButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.queueMessage")}"]`,
    );
    const stopButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.stopGenerating")}"]`,
    );
    expect(queueButton.disabled).toBe(true);
    expect(stopButton.getAttribute("aria-label")).toBe(t("chat.runControls.stopGenerating"));
    stopButton.click();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="New session"]')).toBeNull();

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

    const newSessionButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.newSession")}"]`,
    );
    expect(newSessionButton.getAttribute("aria-label")).toBe(t("chat.runControls.newSession"));
    expect(newSessionButton.textContent).toContain("New session");
    newSessionButton.click();
    expect(onNewSession).toHaveBeenCalledTimes(1);

    const sendButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.sendMessage")}"]`,
    );
    expect(sendButton.getAttribute("aria-label")).toBe(t("chat.runControls.sendMessage"));
    expect(sendButton.textContent).toContain("Send");
    sendButton.click();
    expect(onStoreDraft).toHaveBeenCalledWith(" run this ");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".chat-send-btn--stop")).toBeNull();
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

    const queueButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.queueMessage")}"]`,
    );
    expect(queueButton.disabled).toBe(false);
    queueButton.click();
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

    const stopButton = getButton(
      container,
      `button[aria-label="${t("chat.runControls.stopGenerating")}"]`,
    );
    expect(stopButton.disabled).toBe(false);
    stopButton.click();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("renders run-control labels from the active locale", async () => {
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");
    render(renderChatRunControls(createProps({ hasMessages: true })), container);

    expect(
      getButton(container, `button[aria-label="${t("chat.runControls.newSession")}"]`).textContent,
    ).toContain(t("chat.runControls.newSession"));
    expect(
      getButton(container, `button[aria-label="${t("chat.runControls.exportChat")}"]`).textContent,
    ).toContain(t("chat.runControls.export"));
    expect(
      getButton(container, `button[aria-label="${t("chat.runControls.sendMessage")}"]`).textContent,
    ).toContain(t("chat.runControls.send"));
    expect(container.querySelector('button[aria-label="New session"]')).toBeNull();
  });
});

describe("chat status indicators", () => {
  it("renders only interrupted as a visible composer run status", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      // Working and Done have no composer chrome: the thread spark and content
      // arriving cover them (the sr-only region announces them separately).
      render(renderChatRunStatusIndicator({ phase: "in-progress" }), container);
      expect(container.querySelector(".agent-chat__run-status")).toBeNull();

      render(
        renderChatRunStatusIndicator({
          phase: "done",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 900,
        }),
        container,
      );
      expect(container.querySelector(".agent-chat__run-status")).toBeNull();

      render(
        renderChatRunStatusIndicator({
          phase: "interrupted",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 900,
        }),
        container,
      );
      const indicator = container.querySelector(".agent-chat__run-status--interrupted");
      expect(indicator?.textContent).toContain("Interrupted");
      expect(indicator?.getAttribute("aria-label")).toBe("Run status: Interrupted");

      nowSpy.mockReturnValue(7_000);
      render(
        renderChatRunStatusIndicator({
          phase: "interrupted",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 1_000,
        }),
        container,
      );
      expect(container.querySelector(".agent-chat__run-status--interrupted")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

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
      expect(indicator?.textContent?.trim()).toBe("Compacting context...");
      indicator = container.querySelector(".compaction-indicator--fallback");
      expect(indicator?.textContent?.trim()).toBe(
        "Fallback active: deepinfra/moonshotai/Kimi-K2.5",
      );

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
      expect(indicator?.textContent?.trim()).toBe("Context compacted");
      indicator = container.querySelector(".compaction-indicator--fallback-cleared");
      expect(indicator?.textContent?.trim()).toBe("Fallback cleared: fireworks/minimax-m2p5");

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

  it("treats unavailable provider usage as absent content", () => {
    const container = document.createElement("div");
    render(
      renderContextNotice(undefined, 200_000, {
        providerUsage: { modelAuthStatusResult: null },
      }),
      container,
    );

    expect(container.querySelector(".context-usage")).toBeNull();

    const session: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      totalTokens: 46_000,
      contextTokens: 200_000,
    };
    render(
      renderContextNotice(session, 200_000, {
        providerUsage: { modelAuthStatusResult: null },
      }),
      container,
    );
    expect(container.querySelector(".context-usage")).not.toBeNull();
    expect(container.querySelector(".context-usage__plan-header")).toBeNull();
  });

  it("keeps provider usage available before context token metrics arrive", () => {
    const container = document.createElement("div");
    render(
      renderContextNotice(undefined, 200_000, {
        providerUsage: {
          basePath: "/rosita",
          modelAuthStatusResult: {
            ts: Date.now(),
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                status: "ok",
                profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
                usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
              },
            ],
          },
        },
      }),
      container,
    );

    const context = container.querySelector<HTMLElement>(".context-ring");
    expect(context).toBeInstanceOf(HTMLElement);
    expect(context?.getAttribute("aria-label")).toBe("Usage Remaining");
    expect(context?.querySelector(".context-ring__detail")).toBeNull();
    expect(container.querySelector(".context-usage__bar")).toBeNull();
    expect(container.querySelector(".context-usage__stats")).toBeNull();
    const planHeader = container.querySelector(".context-usage__plan-header");
    expect(planHeader?.textContent?.replace(/\s+/g, " ").trim()).toBe("Plan usage");
    const usageLink = container.querySelector<HTMLAnchorElement>(
      ".context-usage__popover [data-chat-provider-usage='true']",
    );
    expect(usageLink?.getAttribute("href")).toBe("/rosita/usage");
    const limitRow = container.querySelector(".context-usage__limit");
    expect(limitRow?.textContent?.replace(/\s+/g, " ").trim()).toBe("Weekly · all models 72%");
    const limitFill = container.querySelector<HTMLElement>(".context-usage__limit-bar span");
    expect(limitFill?.style.width).toBe("72%");

    render(renderContextNotice(undefined, 200_000), container);
    expect(container.querySelector(".context-usage")).toBeNull();
  });

  it("shows plan windows and hides cost sections for subscription-billed sessions", () => {
    // Single shared timestamp: both auth rows must dedupe to one group, and the
    // 45s pad keeps formatQuotaReset at exactly "2h" despite wall-clock drift.
    const fiveHourReset = Date.now() + 2 * 3_600_000 + 45_000;
    const authStatus: ModelAuthStatusResult = {
      ts: Date.now(),
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          status: "ok",
          profiles: [{ profileId: "anthropic:oauth", type: "oauth", status: "ok" }],
          usage: {
            providerId: "anthropic",
            plan: "Max (20x)",
            windows: [
              { label: "5h", usedPercent: 22, resetAt: fiveHourReset },
              { label: "Week", usedPercent: 25 },
              { label: "Fable", usedPercent: 92 },
            ],
            billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD" }],
          },
        },
        {
          provider: "claude-cli",
          displayName: "Claude",
          status: "ok",
          profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
          usage: {
            providerId: "anthropic",
            plan: "Max (20x)",
            windows: [
              { label: "5h", usedPercent: 22, resetAt: fiveHourReset },
              { label: "Week", usedPercent: 25 },
              { label: "Fable", usedPercent: 92 },
            ],
            billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD" }],
          },
        },
      ],
    };
    const session: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 78_700,
      contextTokens: 1_000_000,
      estimatedCostUsd: 0.02,
      model: "claude-fable-5",
      // sessions.list canonicalizes CLI aliases (claude-cli -> anthropic); the
      // popover must match plan usage through usage.providerId, not the auth
      // row's provider id.
      modelProvider: "anthropic",
    };
    const container = document.createElement("div");
    render(
      renderContextNotice(session, 1_000_000, {
        // Trailing user turn: no assistant cost stats to fall back on.
        messages: [{ role: "user", content: "hi" }],
        providerUsage: { modelAuthStatusResult: authStatus },
      }),
      container,
    );

    // Identical usage exposed via anthropic + claude-cli rows collapses to one group.
    expect(container.querySelectorAll(".context-usage__plan-header")).toHaveLength(1);
    expect(container.querySelector(".context-usage__plan-badge")?.textContent).toBe("Max (20x)");
    const rows = [...container.querySelectorAll(".context-usage__limit")].map((row) =>
      row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toEqual([
      "5-hour limit Resets 2h 22%",
      "Weekly · all models 25%",
      "Fable 92%",
      "Usage credits $157.85 of $400.00",
    ]);
    const fills = [...container.querySelectorAll<HTMLElement>(".context-usage__limit-bar span")];
    expect(fills.map((fill) => fill.style.width)).toEqual(["22%", "25%", "92%", "39%"]);
    expect(fills[2]?.classList.contains("context-usage__limit-fill--danger")).toBe(true);

    // Subscription-billed: token stats stay, dollar estimates disappear.
    expect(container.querySelector(".context-usage__stats")).not.toBeNull();
    expect(container.querySelector(".context-usage__stats--cost")).toBeNull();
    expect(container.textContent).not.toContain("Est. cost");
  });

  it("renders persistent fresh context usage and keeps high-usage warning behavior", () => {
    const container = document.createElement("div");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) =>
        name === "--warn" ? "#010203" : name === "--danger" ? "#040506" : "",
    } as CSSStyleDeclaration);
    resetContextNoticeThemeCacheForTest();

    const lowUsageSession: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      inputTokens: 757_300,
      totalTokens: 46_000,
      contextTokens: 200_000,
      estimatedCostUsd: 0.007725,
      model: "gpt-5.5",
      modelProvider: "openai",
    };
    const providerCostMessages = [
      { role: "assistant", cost: { input: 99, output: 99 } },
      { role: "user", content: "Current turn" },
      {
        role: "assistant",
        model: "openrouter/auto",
        responseModel: "gpt-5.5",
        cost: { input: 0.001225, output: 0.006, cacheRead: 0.0005, cacheWrite: 0 },
      },
    ];
    const lowUsage = getContextNoticeViewModel(lowUsageSession, 200_000);
    if (!lowUsage) {
      throw new Error("expected low usage context notice");
    }
    expect(lowUsage.pct).toBe(23);
    expect(lowUsage.detail).toBe("46k / 200k");
    expect(lowUsage.input).toBe(757_300);
    expect(lowUsage.output).toBeNull();
    expect(lowUsage.cost).toBe(0.007725);
    expect(lowUsage.warning).toBe(false);
    expect(lowUsage.compactRecommended).toBe(false);
    render(
      renderContextNotice(lowUsageSession, 200_000, { messages: providerCostMessages }),
      container,
    );
    const lowNotice = container.querySelector<HTMLElement>(".context-ring");
    expect(lowNotice).toBeInstanceOf(HTMLElement);
    expect([...lowNotice!.classList]).toEqual(["context-ring"]);
    expect(lowNotice!.textContent?.replace(/\s+/gu, " ").trim()).toBe("23%");
    expect(lowNotice!.querySelector(".context-ring__detail")).toBeNull();
    expect(lowNotice!.getAttribute("aria-label")).toBe("Session context usage: 46k of 200k (23%)");
    expect(lowNotice!.tagName.toLowerCase()).toBe("summary");
    const usageDetails = container.querySelector<HTMLDetailsElement>(".context-usage details");
    expect(usageDetails?.open).toBe(false);
    lowNotice!.click();
    expect(usageDetails?.open).toBe(true);
    expect(
      container.querySelector(".context-usage__popover")?.textContent?.replace(/\s+/gu, " ").trim(),
    ).toBe(
      "Context window 46k / 200k · 23% Latest run tokens Input 757.3k Output — Est. cost $0.0077 Cost by Type Input $0.0012 Output $0.0060 Cache Read $0.0005 Cache Write $0.00 Provider: openai Model: gpt-5.5",
    );
    expect(
      container.querySelectorAll(".context-usage__stats:not(.context-usage__stats--cost) > div"),
    ).toHaveLength(3);
    expect(container.querySelectorAll(".context-usage__stats--cost > div")).toHaveLength(4);
    render(
      renderContextNotice(lowUsageSession, 200_000, {
        messages: [...providerCostMessages, { role: "user", content: "Steer before response" }],
      }),
      container,
    );
    expect(container.querySelector(".context-usage__stats--cost")).toBeNull();
    const lowFill = lowNotice!.querySelector(".context-ring__fill");
    expect(lowFill?.tagName.toLowerCase()).toBe("circle");
    // 23% of the 40.84 circumference stays hidden via dashoffset.
    expect(Number.parseFloat(lowFill?.getAttribute("stroke-dashoffset") ?? "")).toBeCloseTo(
      40.84 * 0.77,
      1,
    );
    render(renderContextNotice({ ...lowUsageSession, estimatedCostUsd: 0 }, 200_000), container);
    expect(container.querySelector(".context-usage__stats")?.textContent).toContain("$0.00");

    const session: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      inputTokens: 757_300,
      totalTokens: 190_000,
      contextTokens: 200_000,
    };
    render(renderContextNotice(session, 200_000), container);

    expect(getContextNoticeViewModel(session, 200_000)?.compactRecommended).toBe(true);
    const notice = container.querySelector<HTMLElement>(".context-ring");
    expect(notice).toBeInstanceOf(HTMLElement);
    expect(notice!.textContent?.replace(/\s+/gu, " ").trim()).toBe("95%");
    expect([...notice!.classList]).toEqual(["context-ring", "context-ring--warning"]);
    expect(notice!.getAttribute("aria-label")).toBe("Session context usage: 190k of 200k (95%)");
    const usage = container.querySelector<HTMLElement>(".context-usage");
    expect(usage!.style.getPropertyValue("--ctx-color")).toBe("rgb(4, 5, 6)");
    expect(usage!.style.getPropertyValue("--ctx-bg")).toBe("rgba(4, 5, 6, 0.15999999999999998)");
    expect(container.querySelectorAll(".context-usage__stats > div")).toHaveLength(2);

    const onCompact = vi.fn();
    render(renderContextNotice(session, 200_000, { onCompact }), container);
    const compactButton = getButton(container, ".context-ring__action");
    expect(compactButton.textContent?.trim()).toBe("Compact");
    compactButton.click();
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
    const staleSession: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      totalTokens: 190_000,
      totalTokensFresh: false,
      contextTokens: 200_000,
    };
    expect(getContextNoticeViewModel(staleSession, 200_000)).toMatchObject({
      pct: 95,
      detail: "~190k / 200k",
      approximate: true,
      warning: false,
      compactRecommended: false,
    });
    render(renderContextNotice(staleSession, 200_000, { onCompact }), container);
    const staleNotice = container.querySelector<HTMLElement>(".context-ring");
    expect(staleNotice?.textContent?.trim()).toBe("~95%");
    expect(staleNotice?.classList.contains("context-ring--warning")).toBe(false);
    expect(staleNotice?.getAttribute("aria-label")).toBe(
      "Session context usage: ~190k of 200k (~95%)",
    );
    expect(container.querySelector(".context-ring__action")).toBeNull();
  });
});
