/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";

type ChatQuestionPanelElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

function gatewayPrompt(overrides: Partial<QuestionPrompt> = {}): QuestionPrompt {
  return {
    id: "question-1",
    questions: [
      {
        questionId: "format",
        header: "Format",
        question: "Which format should I use?",
        options: [
          { label: "Compact", description: "Keep it brief" },
          { label: "Detailed", description: "Include rationale" },
        ],
        isOther: true,
      },
    ],
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: 62_000,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
    ...overrides,
  };
}

async function panelIn(container: HTMLElement): Promise<ChatQuestionPanelElement> {
  const panel = container.querySelector("openclaw-chat-question-panel") as ChatQuestionPanelElement;
  await panel.updateComplete;
  return panel;
}

describe("shared question panel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  function drawGateway(
    prompt: QuestionPrompt,
    callbacks: {
      onSubmit?: (answers: Record<string, string[]>) => void | Promise<void>;
      onSkip?: () => void | Promise<void>;
    } = {},
  ) {
    let collapsed = false;
    const redraw = () => {
      render(
        html`<openclaw-chat-question-panel
          .props=${createGatewayQuestionPanelProps(prompt, {
            nowMs: 2_000,
            collapsed,
            onCollapsedChange: (nextCollapsed) => {
              collapsed = nextCollapsed;
              redraw();
            },
            onChange: redraw,
            onSubmit: callbacks.onSubmit ?? vi.fn(),
            onSkip: callbacks.onSkip ?? vi.fn(),
          })}
        ></openclaw-chat-question-panel>`,
        container,
      );
    };
    redraw();
  }

  it("steps from single-select to multi-select and preserves array answers", async () => {
    const prompt = gatewayPrompt({
      questions: [
        {
          questionId: "target",
          header: "Target",
          question: "Where should I send it?",
          options: [{ label: "Chat" }, { label: "File" }],
          isOther: true,
        },
        {
          questionId: "extras",
          header: "Extras",
          question: "Which extras should I include?",
          options: [{ label: "Tests" }, { label: "Docs" }],
          multiSelect: true,
          isOther: true,
        },
      ],
    });
    const onSubmit = vi.fn();
    drawGateway(prompt, { onSubmit });
    const panel = await panelIn(container);

    expect(container.querySelector(".chat-question-panel__progress")?.textContent).toBe("1/2");
    container.querySelector<HTMLButtonElement>('[role="radio"]')?.click();
    await panel.updateComplete;

    expect(container.querySelector(".chat-question-panel__prompt")?.textContent).toBe(
      "Which extras should I include?",
    );
    expect(container.querySelector(".chat-question-panel__progress")?.textContent).toBe("2/2");
    container.querySelector<HTMLButtonElement>(".chat-question-panel__back")?.click();
    await panel.updateComplete;
    expect(container.querySelector(".chat-question-panel__prompt")?.textContent).toBe(
      "Where should I send it?",
    );
    container.querySelector<HTMLButtonElement>('[role="radio"]')?.click();
    await panel.updateComplete;
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[0]?.click();
    container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1]?.click();
    const other = container.querySelector<HTMLInputElement>(".chat-question-panel__other")!;
    other.value = "Metrics";
    other.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await panel.updateComplete;
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.click();

    expect(onSubmit).toHaveBeenCalledWith({
      target: ["Chat"],
      extras: ["Tests", "Docs", "Metrics"],
    });
  });

  it("supports numeric selection and Enter submission while focused", async () => {
    const onSubmit = vi.fn();
    drawGateway(gatewayPrompt(), { onSubmit });
    const panel = await panelIn(container);
    const group = container.querySelector<HTMLElement>(".chat-question-panel")!;

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    await panel.updateComplete;
    expect(
      container.querySelectorAll<HTMLElement>('[role="radio"]')[1]?.getAttribute("aria-checked"),
    ).toBe("true");

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith({ format: ["Detailed"] });
  });

  it("leaves modified numeric shortcuts to the browser", async () => {
    const onSubmit = vi.fn();
    drawGateway(gatewayPrompt(), { onSubmit });
    const panel = await panelIn(container);
    const group = container.querySelector<HTMLElement>(".chat-question-panel")!;

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true }));
    await panel.updateComplete;

    expect(container.querySelector('[aria-checked="true"]')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uses roving radio focus and arrow-key selection", async () => {
    drawGateway(
      gatewayPrompt({
        questions: [
          ...gatewayPrompt().questions,
          {
            questionId: "confirm",
            header: "Confirm",
            question: "Ready to continue?",
            options: [{ label: "Ready" }],
            isOther: false,
          },
        ],
      }),
    );
    const panel = await panelIn(container);
    const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');

    expect([...radios].map((radio) => radio.tabIndex)).toEqual([0, -1]);
    radios[0]?.focus();
    radios[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await panel.updateComplete;

    const updated = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...updated].map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    expect(updated[1]?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(updated[1]);
    expect(container.querySelector(".chat-question-panel__prompt")?.textContent).toBe(
      "Which format should I use?",
    );
  });

  it("uses Enter in Other to advance and submit free text", async () => {
    const onSubmit = vi.fn();
    drawGateway(gatewayPrompt(), { onSubmit });
    const panel = await panelIn(container);
    const other = container.querySelector<HTMLInputElement>(".chat-question-panel__other")!;

    other.value = "Markdown table";
    other.dispatchEvent(new InputEvent("input", { bubbles: true }));
    other.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await panel.updateComplete;

    expect(onSubmit).toHaveBeenCalledWith({ format: ["Markdown table"] });
  });

  it("uses Enter in empty Other to submit an already-selected option", async () => {
    const onSubmit = vi.fn();
    drawGateway(gatewayPrompt(), { onSubmit });
    const panel = await panelIn(container);

    container.querySelector<HTMLButtonElement>('[role="radio"]')?.click();
    await panel.updateComplete;
    const other = container.querySelector<HTMLInputElement>(".chat-question-panel__other")!;
    other.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onSubmit).toHaveBeenCalledWith({ format: ["Compact"] });
  });

  it("collapses without answering and exposes gateway cancellation through Skip", async () => {
    const onSkip = vi.fn();
    drawGateway(gatewayPrompt(), { onSkip });
    const panel = await panelIn(container);

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")?.click();
    await panel.updateComplete;
    expect(container.querySelector(".chat-question-panel--collapsed")?.textContent).toContain(
      "Format",
    );
    expect(onSkip).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")?.click();
    await panel.updateComplete;
    expect(document.activeElement).toBe(container.querySelector(".chat-question-panel"));
    container.querySelector<HTMLButtonElement>(".chat-question-panel__skip")?.click();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("disables actions whose gateway callbacks are unavailable", async () => {
    render(
      html`<openclaw-chat-question-panel
        .props=${createGatewayQuestionPanelProps(gatewayPrompt(), { nowMs: 2_000 })}
      ></openclaw-chat-question-panel>`,
      container,
    );
    await panelIn(container);

    expect(
      container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.disabled,
    ).toBe(true);
    expect(container.querySelector(".chat-question-panel__skip")).toBeNull();
  });

  it("manages collapse state when no controlled callback is supplied", async () => {
    render(
      html`<openclaw-chat-question-panel
        .props=${createGatewayQuestionPanelProps(gatewayPrompt(), { nowMs: 2_000 })}
      ></openclaw-chat-question-panel>`,
      container,
    );
    const panel = await panelIn(container);

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")?.click();
    await panel.updateComplete;
    expect(container.querySelector(".chat-question-panel--collapsed")).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")?.click();
    await panel.updateComplete;
    expect(container.querySelector(".chat-question-panel--collapsed")).toBeNull();
  });

  it("retains answers with submit-only wiring", async () => {
    const onSubmit = vi.fn();
    render(
      html`<openclaw-chat-question-panel
        .props=${createGatewayQuestionPanelProps(gatewayPrompt(), {
          nowMs: 2_000,
          onSubmit,
        })}
      ></openclaw-chat-question-panel>`,
      container,
    );
    const panel = await panelIn(container);

    container.querySelector<HTMLButtonElement>('[role="radio"]')?.click();
    await panel.updateComplete;
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.click();

    expect(onSubmit).toHaveBeenCalledWith({ format: ["Compact"] });
  });

  it("keeps Skip available with skip-only wiring", async () => {
    const onSkip = vi.fn();
    render(
      html`<openclaw-chat-question-panel
        .props=${createGatewayQuestionPanelProps(gatewayPrompt(), {
          nowMs: 2_000,
          onSkip,
        })}
      ></openclaw-chat-question-panel>`,
      container,
    );
    await panelIn(container);

    expect(
      container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.disabled,
    ).toBe(true);
    container.querySelector<HTMLButtonElement>(".chat-question-panel__skip")?.click();
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
