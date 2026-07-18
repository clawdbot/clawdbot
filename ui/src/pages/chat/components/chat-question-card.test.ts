/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import type { QuestionStatus } from "../tool-stream.ts";
import { createCodexQuestionCardProps, renderChatQuestionCard } from "./chat-question-card.ts";

type ChatQuestionCardElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

function codexStatus(overrides: Partial<QuestionStatus> = {}): QuestionStatus {
  return {
    itemId: "item-1",
    actionToken: "test-action-token",
    questions: [
      {
        id: "mode",
        header: "Mode",
        question: "Pick one",
        isOther: false,
        options: [{ label: "Fast" }, { label: " Deep ", description: "More reasoning" }],
      },
    ],
    ...overrides,
  };
}

function gatewayPrompt(overrides: Partial<QuestionPrompt> = {}): QuestionPrompt {
  return {
    id: "question-1",
    questions: [
      {
        id: "format",
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

async function cardIn(container: HTMLElement): Promise<ChatQuestionCardElement> {
  const card = container.querySelector("openclaw-chat-question") as ChatQuestionCardElement;
  await card.updateComplete;
  return card;
}

describe("shared question card", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe("Codex adapter", () => {
    function draw(
      status: QuestionStatus,
      onSubmit: (answers: Record<string, string>, onRejected: () => void) => void,
    ) {
      render(
        html`<openclaw-chat-question
          .props=${createCodexQuestionCardProps(status, { disabled: false, onSubmit })}
        ></openclaw-chat-question>`,
        container,
      );
    }

    it("submits a selected native option through the string-answer seam", async () => {
      const onSubmit = vi.fn();
      draw(codexStatus(), onSubmit);
      const card = await cardIn(container);
      const options = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');

      options[1]!.click();
      await card.updateComplete;
      container.querySelector<HTMLButtonElement>(".chat-question__submit")!.click();

      expect(onSubmit).toHaveBeenCalledWith({ mode: " Deep " }, expect.any(Function));
      await card.updateComplete;
      expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
        true,
      );
    });

    it("keeps the main submit label when the composer is disconnected", async () => {
      render(
        html`<openclaw-chat-question
          .props=${createCodexQuestionCardProps(codexStatus(), {
            disabled: true,
            onSubmit: vi.fn(),
          })}
        ></openclaw-chat-question>`,
        container,
      );
      await cardIn(container);

      const submit = container.querySelector<HTMLButtonElement>(".chat-question__submit");
      expect(submit?.textContent?.trim()).toBe("Submit answer");
      expect(submit?.disabled).toBe(true);
    });

    it("re-enables submission when the scoped command is rejected", async () => {
      let reject: (() => void) | undefined;
      draw(codexStatus(), (_answers, onRejected) => {
        reject = onRejected;
      });
      const card = await cardIn(container);
      container.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
      await card.updateComplete;
      const submit = container.querySelector<HTMLButtonElement>(".chat-question__submit")!;
      submit.click();
      await card.updateComplete;
      expect(submit.disabled).toBe(true);

      reject?.();
      await Promise.resolve();
      await card.updateComplete;
      expect(submit.disabled).toBe(false);
    });

    it("clears free-form text when the request key changes", async () => {
      const status = codexStatus({
        itemId: "reused-item",
        questions: [
          {
            id: "other",
            header: "Alternative",
            question: "Type another answer",
            isOther: true,
            options: [],
          },
        ],
      });
      draw(status, vi.fn());
      const card = await cardIn(container);
      const input = container.querySelector<HTMLInputElement>(".chat-question__other")!;
      input.value = "stale answer";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await card.updateComplete;

      // A new itemId changes the request key exactly like a new action token.
      draw({ ...status, itemId: "item-second-request" }, vi.fn());
      await card.updateComplete;
      expect(container.querySelector<HTMLInputElement>(".chat-question__other")?.value).toBe("");
    });

    it("preserves free-form text that begins with an option label", async () => {
      draw(
        codexStatus({
          questions: [
            {
              id: "reason",
              header: "Decision",
              question: "Continue?",
              isOther: true,
              options: [{ label: "No" }],
            },
          ],
        }),
        vi.fn(),
      );
      const card = await cardIn(container);
      const input = container.querySelector<HTMLInputElement>(".chat-question__other")!;
      input.value = "No, because the proof failed";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await card.updateComplete;

      expect(input.value).toBe("No, because the proof failed");
    });
  });

  describe("gateway adapter", () => {
    async function draw(
      prompt: QuestionPrompt,
      onSubmit: (answers: Record<string, string[]>) => void | Promise<void> = vi.fn(),
    ) {
      const redraw = () => {
        render(
          renderChatQuestionCard(prompt, {
            nowMs: 2_000,
            onChange: redraw,
            onSubmit,
          }),
          container,
        );
      };
      redraw();
      await cardIn(container);
      return onSubmit;
    }

    it("submits multiselect options and free text as arrays", async () => {
      const prompt = gatewayPrompt({
        questions: [
          {
            id: "extras",
            header: "Extras",
            question: "Which extras should I include?",
            options: [{ label: "Tests" }, { label: "Docs" }],
            multiSelect: true,
            isOther: true,
          },
          {
            id: "target",
            header: "Target",
            question: "Where should I send it?",
            options: [{ label: "Chat" }, { label: "File" }],
            isOther: true,
          },
        ],
      });
      const onSubmit = await draw(prompt);
      const card = await cardIn(container);
      const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      checkboxes[0]?.click();
      checkboxes[1]?.click();
      const targetInput = container.querySelectorAll<HTMLInputElement>(".chat-question__other")[1]!;
      targetInput.value = "Issue comment";
      targetInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await card.updateComplete;

      container.querySelector<HTMLButtonElement>(".chat-question__submit")?.click();

      expect(onSubmit).toHaveBeenCalledWith({
        extras: ["Tests", "Docs"],
        target: ["Issue comment"],
      });
    });

    it("renders countdown and answered-elsewhere state", async () => {
      const prompt = gatewayPrompt();
      await draw(prompt);
      expect(container.querySelector(".chat-question__countdown")?.textContent).toBe("1:00");

      prompt.status = "answered";
      prompt.answeredElsewhere = true;
      prompt.answers = { answers: { format: { answers: ["Detailed"] } } };
      await draw(prompt);

      expect(container.querySelector(".chat-question__status")?.textContent).toBe(
        "Answered elsewhere",
      );
      expect(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]?.checked).toBe(
        true,
      );
      expect(container.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBe(true);
    });

    it.each([
      ["expired", "Expired"],
      ["cancelled", "Cancelled"],
    ] as const)("renders %s terminal state", async (status, label) => {
      await draw(gatewayPrompt({ status }));

      expect(container.querySelector(".chat-question__status")?.textContent).toBe(label);
      expect(container.querySelector(".chat-question__submit")).toBeNull();
    });

    it("shows resolve errors while leaving another attempt enabled", async () => {
      const prompt = gatewayPrompt({ error: "gateway unavailable" });
      await draw(prompt);

      expect(container.querySelector(".chat-question__error")?.textContent).toContain(
        "gateway unavailable",
      );
      expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
        true,
      );
      container.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
      await cardIn(container);
      expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
        false,
      );
    });

    it("clears the private submitted latch after a handled gateway rejection", async () => {
      const prompt = gatewayPrompt();
      await draw(prompt, async () => {
        prompt.error = "gateway unavailable";
      });
      const card = await cardIn(container);
      container.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
      await card.updateComplete;

      container.querySelector<HTMLButtonElement>(".chat-question__submit")?.click();

      await vi.waitFor(() =>
        expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
          false,
        ),
      );
    });
  });
});
