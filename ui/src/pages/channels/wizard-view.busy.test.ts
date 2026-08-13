/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ChannelWizardStep } from "./wizard-controller.ts";
import { renderChannelWizard } from "./wizard-view.ts";

function renderStep(
  step: ChannelWizardStep,
  busy = true,
  textValue = typeof step.initialValue === "string" ? step.initialValue : "",
) {
  const container = document.createElement("div");
  const onAnswer = vi.fn();
  const onClose = vi.fn();
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
      textValue,
      secretVisible: false,
      onTextInput: vi.fn(),
      onToggleSecretVisibility: vi.fn(),
      onAnswer,
      onClose,
      whatsappQrDataUrl: null,
      whatsappMessage: null,
      whatsappConnected: null,
      whatsappBusy: false,
      onWhatsAppStart: vi.fn(),
      onWhatsAppWait: vi.fn(),
    }),
    container,
  );
  return { container, onAnswer, onClose, onToggleMultiselect };
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
    expect(confirmButtons.map((button) => button.textContent?.trim())).toEqual(["No", "Yes"]);
    expect(confirmButtons.every((button) => button.disabled)).toBe(true);
    confirmButtons.forEach((button) => button.click());
    expect(confirm.onAnswer).not.toHaveBeenCalled();
  });

  it.each([
    { message: "Installing channel plugin", expectedStatus: "Installing channel plugin" },
    { message: undefined, expectedStatus: "Working…" },
  ])(
    "announces gateway-owned progress and keeps cancellation available",
    ({ message, expectedStatus }) => {
      const progress = renderStep({
        id: "install-progress",
        type: "progress",
        executor: "gateway",
        ...(message ? { message } : {}),
      });

      const status = progress.container.querySelector<HTMLElement>('[role="status"]');
      expect(status?.textContent?.trim()).toBe(expectedStatus);
      expect(status?.getAttribute("aria-live")).toBe("polite");
      expect(progress.container.querySelectorAll('[role="status"]')).toHaveLength(1);

      const cancel = progress.container.querySelector<HTMLButtonElement>(
        ".channels-wizard__footer button",
      );
      expect(cancel?.textContent?.trim()).toBe("Cancel");
      expect(progress.container.querySelector(".channels-wizard__footer .primary")).toBeNull();
      cancel?.click();
      expect(progress.onClose).toHaveBeenCalledOnce();
      expect(progress.onAnswer).not.toHaveBeenCalled();
    },
  );

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
    const group = select.container.querySelector("wa-select");
    expect(group?.hasAttribute("disabled")).toBe(true);
    expect(group?.querySelector('[slot="label"]')?.textContent).toBe("Pick one");
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
    const text = renderStep(
      {
        id: "text",
        type: "text",
        message: "Enter a value",
        sensitive: true,
      },
      true,
      "replacement",
    );
    const input = text.container.querySelector<HTMLInputElement>('input[name="wizard-text"]');
    const submit = text.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    const toggle = text.container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect(input?.disabled).toBe(true);
    expect(input?.type).toBe("password");
    expect(input?.value).toBe("replacement");
    expect(toggle?.disabled).toBe(true);
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
    const picker = select.container.querySelector("wa-select");
    expect(picker?.hasAttribute("disabled")).toBe(false);
  });
});
