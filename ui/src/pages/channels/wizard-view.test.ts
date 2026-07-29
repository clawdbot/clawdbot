/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderChannelWizard } from "./wizard-view.ts";

describe("renderChannelWizard", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
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
    },
  );

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
    expect(copiedText).toBe("openclaw channels add");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
