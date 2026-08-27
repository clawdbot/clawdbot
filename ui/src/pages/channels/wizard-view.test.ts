/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
    delete (document as unknown as { execCommand?: unknown }).execCommand;
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

  it("copies setup text through the plain-HTTP clipboard fallback", async () => {
    vi.stubGlobal("navigator", {});
    let copiedText: string | undefined;
    const execCommand = vi.fn().mockImplementation(() => {
      copiedText = document.querySelector<HTMLTextAreaElement>("textarea")?.value;
      return true;
    });
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChannelWizard({
        wizard: {
          phase: "step",
          channel: null,
          step: {
            id: "copy-command",
            type: "note",
            message: "openclaw channels add",
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

    const copy = container.querySelector<HTMLButtonElement>(".channels-wizard__links button");
    expect(copy).not.toBeNull();
    copy?.click();

    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    await vi.waitFor(() => expect(copy?.textContent?.trim()).toBe("Copied!"));
    expect(copy?.getAttribute("aria-label")).toBeNull();
    expect(copiedText).toBe("openclaw channels add");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it.each(
    [true, false].flatMap((copied) => ["pending", "feedback"].map((phase) => ({ copied, phase }))),
  )(
    "keeps channel-copy success $copied accessible across a $phase locale rerender",
    async ({ copied, phase }) => {
      const write = createDeferred();
      const writeText = vi.fn(() => write.promise);
      const execCommand = vi.fn(() => false);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
      const schedule = vi.spyOn(window, "setTimeout");
      const container = document.createElement("div");
      document.body.append(container);
      const props = {
        wizard: {
          phase: "step",
          channel: null,
          step: { id: "copy-command", type: "note", message: "openclaw channels add" },
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
      } satisfies Parameters<typeof renderChannelWizard>[0];
      render(renderChannelWizard(props), container);
      const button = container.querySelector<HTMLButtonElement>(".channels-wizard__links button");

      button?.click();

      if (phase === "pending") {
        expect(button?.disabled).toBe(true);
        await i18n.setLocale("de");
        render(renderChannelWizard(props), container);
        expect(button?.textContent?.trim()).toBe("Kopieren");
        expect(button?.getAttribute("aria-label")).toBeNull();
      }
      if (copied) {
        write.resolve();
      } else {
        write.reject(new DOMException("Clipboard access denied"));
      }
      const feedback =
        phase === "pending"
          ? copied
            ? "Kopiert!"
            : "Kopieren fehlgeschlagen"
          : copied
            ? "Copied!"
            : "Copy failed";
      await vi.waitFor(() => expect(button?.textContent?.trim()).toBe(feedback));
      expect(button?.getAttribute("aria-label")).toBeNull();
      expect(writeText).toHaveBeenCalledWith("openclaw channels add");
      expect(execCommand).toHaveBeenCalledTimes(copied ? 0 : 1);

      if (phase === "feedback") {
        await i18n.setLocale("de");
        expect(() => render(renderChannelWizard(props), container)).not.toThrow();
        expect(button?.textContent?.trim()).toBe("Kopieren");
        expect(button?.getAttribute("aria-label")).toBeNull();
      }
      const reset = schedule.mock.calls.find(
        ([, delay]) => delay === (copied ? 1_500 : 2_000),
      )?.[0];
      if (typeof reset !== "function") {
        throw new Error("Expected copy feedback to schedule its reset");
      }
      reset();
      expect(button?.textContent?.trim()).toBe("Kopieren");
      expect(button?.getAttribute("aria-label")).toBeNull();

      await i18n.setLocale("en");
      render(renderChannelWizard(props), container);
      expect(button?.textContent?.trim()).toBe("Copy");
      expect(button?.getAttribute("aria-label")).toBeNull();
    },
  );
});
