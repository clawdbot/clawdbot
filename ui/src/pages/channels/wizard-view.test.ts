/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderChannelWizard } from "./wizard-view.ts";

describe("renderChannelWizard", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { sensitive: false, expectedType: "text" },
    { sensitive: true, expectedType: "password" },
  ])(
    "labels a $expectedType input with the visible text-step message",
    ({ sensitive, expectedType }) => {
      const container = document.createElement("div");
      document.body.append(container);
      render(
        renderChannelWizard({
          wizard: {
            phase: "step",
            channel: "matrix",
            step: {
              id: "account-id",
              type: "text",
              message: "New Matrix account id",
              sensitive,
            },
            stepIndex: 1,
            busy: false,
            validationError: null,
          },
          channelLabel: (channelId) => channelId,
          multiselectValues: [],
          onToggleMultiselect: vi.fn(),
          textValue: "",
          secretVisible: false,
          onTextInput: vi.fn(),
          onToggleSecretVisibility: vi.fn(),
          onAnswer: vi.fn(),
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

      const input = container.querySelector<HTMLInputElement>("#channel-wizard-text-input");
      const label = container.querySelector<HTMLLabelElement>(
        'label[for="channel-wizard-text-input"]',
      );
      expect(label?.textContent).toBe("New Matrix account id");
      expect(input?.type).toBe(expectedType);
      expect(input?.labels).toContain(label);
      if (sensitive) {
        expect(container.querySelector(".oc-sensitive-toggle")).not.toBeNull();
      } else {
        expect(container.querySelector(".oc-sensitive-toggle")).toBeNull();
      }
    },
  );

  it("reveals only the replacement value entered in a sensitive step", () => {
    const container = document.createElement("div");
    const onTextInput = vi.fn();
    const onToggleSecretVisibility = vi.fn();
    document.body.append(container);
    const renderSensitiveStep = (secretVisible: boolean, textValue: string) =>
      render(
        renderChannelWizard({
          wizard: {
            phase: "step",
            channel: "twitch",
            step: {
              id: "client-secret",
              type: "text",
              message: "Twitch Client Secret",
              sensitive: true,
            },
            stepIndex: 1,
            busy: false,
            validationError: null,
          },
          channelLabel: (channelId) => channelId,
          multiselectValues: [],
          onToggleMultiselect: vi.fn(),
          textValue,
          secretVisible,
          onTextInput,
          onToggleSecretVisibility,
          onAnswer: vi.fn(),
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

    renderSensitiveStep(false, "");
    const hiddenInput = container.querySelector<HTMLInputElement>("#channel-wizard-text-input");
    const toggle = container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect(hiddenInput?.type).toBe("password");
    expect(hiddenInput?.value).toBe("");
    expect(toggle?.getAttribute("aria-label")).toBe("Reveal value");
    expect(toggle?.dataset.sensitiveIcon).toBe("eye");
    if (hiddenInput) {
      hiddenInput.value = "new-secret";
      hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    toggle?.click();
    expect(onTextInput).toHaveBeenCalledWith("new-secret");
    expect(onToggleSecretVisibility).toHaveBeenCalledOnce();

    renderSensitiveStep(true, "new-secret");
    const revealedInput = container.querySelector<HTMLInputElement>("#channel-wizard-text-input");
    const hideToggle = container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect(revealedInput?.type).toBe("text");
    expect(revealedInput?.value).toBe("new-secret");
    expect(hideToggle?.getAttribute("aria-label")).toBe("Hide value");
    expect(hideToggle?.getAttribute("aria-pressed")).toBe("true");
    expect(hideToggle?.dataset.sensitiveIcon).toBe("eye-off");
  });

  it("renders informational setup output as unpadded plain text", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChannelWizard({
        wizard: {
          phase: "step",
          channel: "imessage",
          step: {
            id: "selected-channels",
            type: "note",
            title: "Selected channels",
            message: "iMessage — Local iMessage/SMS through the imsg bridge.",
          },
          stepIndex: 1,
          busy: false,
          validationError: null,
        },
        channelLabel: () => "iMessage",
        multiselectValues: [],
        onToggleMultiselect: vi.fn(),
        textValue: "",
        secretVisible: false,
        onTextInput: vi.fn(),
        onToggleSecretVisibility: vi.fn(),
        onAnswer: vi.fn(),
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

    const output = container.querySelector(".channels-wizard__output");
    expect(output?.textContent).toBe("iMessage — Local iMessage/SMS through the imsg bridge.");
    expect(container.querySelector(".channels-wizard__note")).toBeNull();
    expect(container.querySelector(".channels-wizard__links button")).toBeNull();
  });

  it("links channel docs from the setup subtitle without static helper links", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChannelWizard({
        wizard: {
          phase: "error",
          channel: "slack",
          message: "Setup failed",
        },
        channelLabel: () => "Slack",
        multiselectValues: [],
        onToggleMultiselect: vi.fn(),
        textValue: "",
        secretVisible: false,
        onTextInput: vi.fn(),
        onToggleSecretVisibility: vi.fn(),
        onAnswer: vi.fn(),
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

    const subtitle = container.querySelector(".channels-wizard__subtitle");
    const docs = subtitle?.querySelector<HTMLAnchorElement>(".channels-wizard__link");
    expect(subtitle?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      "Guided channel setup View docs",
    );
    expect(docs?.href).toBe("https://docs.openclaw.ai/channels/slack");
    expect(container.querySelector(".channels-wizard__links")).toBeNull();
  });
});
