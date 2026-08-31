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

  it("keeps a store-bound secret masked while preserving editable destination hosts", async () => {
    const prompt = gatewayPrompt({
      agentId: "release-agent",
      questions: [
        {
          questionId: "api_key",
          header: "API key",
          question: "Provide the deployment API key",
          options: [],
          isSecret: true,
          secretStore: {
            name: "FAKE_DEPLOYMENT_API_KEY",
            kind: "secret",
            allowedHosts: ["api.example.test"],
            reason: "Deploy the approved release",
          },
          secretStoreExisting: {
            updatedAtMs: Date.now() - 60_000,
            updatedBy: "release-owner",
          },
        },
      ],
    });
    const onSubmit = vi.fn();
    drawGateway(prompt, { onSubmit });
    const panel = await panelIn(container);
    const hosts = container.querySelector<HTMLInputElement>(".chat-question-panel__hosts")!;
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!;

    expect(hosts.value).toBe("api.example.test");
    expect(secret.autocomplete).toBe("off");
    expect(container.textContent).toContain("release-agent");
    expect(container.textContent).toContain("agent:main:main");
    expect(container.textContent).toContain("Stores FAKE_DEPLOYMENT_API_KEY as Protected secret");
    expect(container.textContent).toContain("Deploy the approved release");
    expect(container.textContent).toContain("Replaces FAKE_DEPLOYMENT_API_KEY — last updated");
    expect(container.textContent).toContain("by release-owner");

    hosts.value = "api.example.test, uploads.example.test";
    hosts.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await panel.updateComplete;
    expect(prompt.secretStoreAllowedHostsDraft).toBe("api.example.test, uploads.example.test");

    const fakeSecret = "  fake-secret-value-for-ui-test  ";
    secret.value = fakeSecret;
    secret.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await panel.updateComplete;
    expect(prompt.drafts.get("api_key")?.freeText).toBe(fakeSecret);
    expect(secret.value).toBe(fakeSecret);
    expect(container.textContent).not.toContain(fakeSecret);
    expect(container.innerHTML).not.toContain(fakeSecret);

    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.click();
    expect(onSubmit).toHaveBeenCalledWith({ api_key: [fakeSecret] });
  });

  it.each([
    { isSecret: true, value: "  synthetic-value  ", expected: "  synthetic-value  " },
    { isSecret: true, value: "   ", expected: "   " },
    { isSecret: true, value: "", expected: null },
    { isSecret: false, value: "  normal answer  ", expected: "normal answer" },
    { isSecret: false, value: "   ", expected: null },
  ])(
    "preserves or normalizes hydrated drafts: $isSecret / '$value'",
    async ({ isSecret, value, expected }) => {
      const prompt = gatewayPrompt({
        questions: [
          {
            questionId: "value",
            header: "Value",
            question: "Provide a value",
            options: [],
            isSecret,
          },
        ],
        drafts: new Map([["value", { selected: new Set<string>(), freeText: value }]]),
      });
      const onSubmit = vi.fn();
      drawGateway(prompt, { onSubmit });
      await panelIn(container);
      const input = container.querySelector<HTMLInputElement>("input")!;
      const submit = container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!;
      expect(input.value).toBe(expected ?? "");
      expect(submit.disabled).toBe(expected === null);
      submit.click();
      if (expected === null) {
        expect(onSubmit).not.toHaveBeenCalled();
      } else {
        expect(onSubmit).toHaveBeenCalledWith({ value: [expected] });
      }
    },
  );

  it("keeps environment store requests masked without exposing a destination-host editor", async () => {
    drawGateway(
      gatewayPrompt({
        questions: [
          {
            questionId: "environment_value",
            header: "Environment",
            question: "Provide the environment value",
            options: [],
            isSecret: true,
            secretStore: { name: "FAKE_ENVIRONMENT_VALUE", kind: "env" },
          },
        ],
      }),
    );
    await panelIn(container);

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector(".chat-question-panel__hosts")).toBeNull();
    expect(container.textContent).toContain(
      "Stores FAKE_ENVIRONMENT_VALUE as Agent-readable environment",
    );
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
        .props=${createGatewayQuestionPanelProps(gatewayPrompt(), {})}
      ></openclaw-chat-question-panel>`,
      container,
    );
    await panelIn(container);

    expect(
      container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")?.disabled,
    ).toBe(true);
    expect(container.querySelector(".chat-question-panel__skip")).toBeNull();
  });

  it("does not render the request expiry countdown", async () => {
    drawGateway(gatewayPrompt());
    await panelIn(container);

    expect(container.querySelector(".chat-question-panel__countdown")).toBeNull();
    expect(container.textContent).not.toContain("1:00");
  });

  it("manages collapse state when no controlled callback is supplied", async () => {
    render(
      html`<openclaw-chat-question-panel
        .props=${createGatewayQuestionPanelProps(gatewayPrompt(), {})}
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
