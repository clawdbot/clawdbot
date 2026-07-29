/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ChannelWizardStep } from "./wizard-controller.ts";
import { renderChannelWizard } from "./wizard-view.ts";

function renderStep(step: ChannelWizardStep, busy = true) {
  const container = document.createElement("div");
  const onAnswer = vi.fn();
  const onToggleMultiselect = vi.fn();
  document.body.append(container);
  render(
    renderChannelWizard({
      wizard: {
        phase: "step",
        channel: null,
        step,
        stepIndex: 1,
        busy,
        validationError: null,
      },
      channelLabel: (channelId) => channelId,
      multiselectValues: ["alpha"],
      onToggleMultiselect,
      onAnswer,
      onClose: vi.fn(),
      whatsappQrDataUrl: null,
      whatsappMessage: null,
      whatsappConnected: null,
      whatsappBusy: false,
      onWhatsAppStart: vi.fn(),
      onWhatsAppWait: vi.fn(),
    }),
    container,
  );
  return { container, onAnswer, onToggleMultiselect };
}

describe("renderChannelWizard busy controls", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("disables note and confirm answers while a step is running", () => {
    const note = renderStep({ id: "note", type: "note", message: "Do this" });
    const noteContinue = note.container.querySelector<HTMLButtonElement>(
      ".channels-wizard__footer .primary",
    );
    expect(noteContinue?.disabled).toBe(true);
    noteContinue?.click();
    expect(note.onAnswer).not.toHaveBeenCalled();

    const confirm = renderStep({ id: "confirm", type: "confirm", message: "Continue?" });
    const confirmButtons = Array.from(
      confirm.container.querySelectorAll<HTMLButtonElement>(".channels-wizard__footer button"),
    );
    expect(confirmButtons).toHaveLength(2);
    expect(confirmButtons.every((button) => button.disabled)).toBe(true);
    confirmButtons.forEach((button) => button.click());
    expect(confirm.onAnswer).not.toHaveBeenCalled();
  });

  it("disables select choices while a step is running", () => {
    const select = renderStep({
      id: "select",
      type: "select",
      message: "Pick one",
      options: [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
      ],
    });
    const group = select.container.querySelector<HTMLElement & { disabled: boolean }>(
      "wa-radio-group",
    );
    expect(group?.disabled).toBe(true);
    expect(group?.hasAttribute("disabled")).toBe(true);
  });

  it("disables multiselect choices and submission while a step is running", () => {
    const multiselect = renderStep({
      id: "multi",
      type: "multiselect",
      message: "Pick several",
      options: [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
      ],
    });
    const buttons = Array.from(multiselect.container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    buttons.forEach((button) => button.click());
    expect(multiselect.onToggleMultiselect).not.toHaveBeenCalled();
    expect(multiselect.onAnswer).not.toHaveBeenCalled();
  });

  it("disables text editing and submission while a step is running", () => {
    const text = renderStep({
      id: "text",
      type: "text",
      message: "Enter a value",
      initialValue: "original",
    });
    const input = text.container.querySelector<HTMLInputElement>('input[name="wizard-text"]');
    const submit = text.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(input?.disabled).toBe(true);
    expect(input?.value).toBe("original");
    expect(submit?.disabled).toBe(true);
    submit?.click();
    expect(text.onAnswer).not.toHaveBeenCalled();
  });

  it("keeps controls enabled when no step request is running", () => {
    const text = renderStep(
      { id: "text", type: "text", message: "Enter a value", initialValue: "original" },
      false,
    );
    expect(text.container.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
    expect(text.container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);

    const select = renderStep(
      {
        id: "select",
        type: "select",
        options: [{ label: "Alpha", value: "alpha" }],
      },
      false,
    );
    expect(
      select.container.querySelector<HTMLElement & { disabled: boolean }>("wa-radio-group")
        ?.disabled,
    ).toBe(false);
  });
});
