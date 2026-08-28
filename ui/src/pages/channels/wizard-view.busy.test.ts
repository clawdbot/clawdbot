/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ChannelWizardStep } from "./wizard-controller.ts";
import { renderChannelWizard } from "./wizard-view.ts";

type WizardProps = Parameters<typeof renderChannelWizard>[0];

function renderWizard(wizard: WizardProps["wizard"], overrides: Partial<WizardProps> = {}) {
  const container = document.createElement("div");
  const onAnswer = vi.fn();
  const onClose = vi.fn();
  const onToggleMultiselect = vi.fn();
  document.body.append(container);
  render(
    renderChannelWizard({
      wizard,
      channelLabel: (channelId) => channelId,
      multiselectValues: ["alpha"],
      onToggleMultiselect,
      textValue: "",
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
      ...overrides,
    }),
    container,
  );
  return { container, onAnswer, onClose, onToggleMultiselect };
}

function renderStep(
  step: ChannelWizardStep,
  busy = true,
  textValue = typeof step.initialValue === "string" ? step.initialValue : "",
) {
  return renderWizard(
    {
      phase: "step",
      channel: null,
      step,
      stepIndex: 1,
      busy,
      validationError: null,
    },
    { textValue },
  );
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

  it.each([
    { name: "note", step: { id: "note", type: "note", message: "Do this" } },
    {
      name: "select",
      step: {
        id: "select",
        type: "select",
        message: "Pick one",
        options: [{ label: "Alpha", value: "alpha" }],
      },
    },
    {
      name: "multiselect",
      step: {
        id: "multi",
        type: "multiselect",
        message: "Pick several",
        options: [{ label: "Alpha", value: "alpha" }],
      },
    },
    { name: "text", step: { id: "text", type: "text", message: "Enter a value" } },
    { name: "confirm", step: { id: "confirm", type: "confirm", message: "Continue?" } },
    { name: "action", step: { id: "action", type: "action", message: "Run action" } },
    { name: "progress", step: { id: "progress", type: "progress", message: "Run action" } },
  ] satisfies Array<{ name: string; step: ChannelWizardStep }>)(
    "shows one spinner button while a $name answer is running",
    ({ step }) => {
      const rendered = renderStep(step);
      const busyButton = rendered.container.querySelector<HTMLButtonElement>(
        '.channels-wizard__footer button[aria-busy="true"]',
      );

      expect(busyButton?.disabled).toBe(true);
      expect(busyButton?.getAttribute("aria-label")).toBe("Continue");
      expect(busyButton?.querySelector(".btn__label")?.textContent).toBe("Continue");
      expect(busyButton?.querySelector(".btn__spinner")).not.toBeNull();
      expect(busyButton?.querySelector(".btn__label + .btn__spinner")).not.toBeNull();
      expect(busyButton?.querySelector(".sr-only")?.textContent).toBe("Working…");
      expect(rendered.container.querySelectorAll(".btn__spinner")).toHaveLength(1);
      expect(
        Array.from(rendered.container.querySelectorAll(".channels-wizard__spinner")).some(
          (element) => element.textContent?.trim() === "Working…",
        ),
      ).toBe(false);
      busyButton?.click();
      expect(rendered.onAnswer).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "wizard startup",
      wizard: { phase: "starting", channel: "telegram" } as const,
      overrides: {},
      status: "Starting setup…",
    },
    {
      name: "WhatsApp QR loading",
      wizard: {
        phase: "done",
        channel: "whatsapp",
        channels: ["whatsapp"],
        accounts: [{ channel: "whatsapp", accountId: "default" }],
      } as const,
      overrides: { whatsappBusy: true },
      status: "Generating QR code…",
    },
  ])("uses the same spinner button for $name", ({ wizard, overrides, status }) => {
    const rendered = renderWizard(wizard, overrides);
    const busyButton = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]',
    );

    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.getAttribute("aria-label")).toBe("Continue");
    expect(busyButton?.querySelector(".btn__label")?.textContent).toBe("Continue");
    expect(busyButton?.querySelector(".btn__spinner")).not.toBeNull();
    expect(busyButton?.querySelector(".btn__label + .btn__spinner")).not.toBeNull();
    expect(busyButton?.querySelector(".sr-only")?.textContent).toBe(status);
    expect(rendered.container.querySelectorAll(".btn__spinner")).toHaveLength(1);
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
      const busyButton = progress.container.querySelector<HTMLButtonElement>(
        '.channels-wizard__footer button[aria-busy="true"]',
      );
      expect(busyButton?.disabled).toBe(true);
      expect(busyButton?.querySelector(".btn__spinner")).not.toBeNull();

      const cancel = progress.container.querySelector<HTMLButtonElement>(
        '.channels-wizard__footer button:not([aria-busy="true"])',
      );
      expect(cancel?.textContent?.trim()).toBe("Cancel");
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

  it("shows the channel prompt inside an unselected channel picker", () => {
    const select = renderStep(
      {
        id: "channel",
        type: "select",
        message: "Select a channel",
        options: [
          { label: "Telegram", value: "telegram" },
          { label: "Discord", value: "discord" },
        ],
      },
      false,
    );

    expect(select.container.querySelector("wa-select")?.getAttribute("placeholder")).toBe(
      "Select a channel",
    );
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
    const submit = text.container.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
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
