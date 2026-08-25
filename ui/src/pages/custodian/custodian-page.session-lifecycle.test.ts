/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type MountedCustodianPage = Awaited<ReturnType<typeof mountPage>>["page"];

async function sendMessage(page: MountedCustodianPage, message: string): Promise<void> {
  const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
  composer.value = message;
  composer.dispatchEvent(new Event("input"));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
}

describe("custodian page session lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps a cancellation-locked QR visible without a Cancel action", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      sessionId: "locked-qr-session",
      reply: "Scan to link Signal.",
      action: "none",
      step: {
        id: "signal-link",
        type: "qr",
        executor: "gateway",
        qrDataUrl: "data:image/png;base64,aGVsbG8=",
        canCancel: false,
      },
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await waitForFast(() => {
      expect(page.querySelector(".custodian__wizard-step img")).not.toBeNull();
    });
    expect(page.querySelector(".custodian__wizard-cancel")).toBeNull();
  });

  it("starts fresh after the gateway invalidates the live session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "engine-session-before-error",
        reply: "Welcome.",
        action: "none",
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "OpenClaw inference became unavailable.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "engine-session-after-error",
        reply: "Fresh session ready.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome."));

    await sendMessage(page, "status please");

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForFast(() => expect(page.textContent).toContain("Fresh session ready."));
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("engine-session-before-error");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(page.textContent).toContain("Earlier");
    expect(page.textContent).toContain("started a fresh session");
  });

  it("starts fresh after the gateway evicts a typed wizard session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "evicted-wizard-session",
        reply: "Choose a channel.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "channel",
          type: "select",
          message: "Which channel?",
          options: [
            { label: "Slack", value: "slack" },
            { label: "Twitch", value: "twitch" },
          ],
        },
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "No active OpenClaw chat session is awaiting that wizard answer.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "replacement-session",
        reply: "Fresh session ready.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() =>
      expect(page.querySelectorAll('.custodian__wizard-step input[type="radio"]')).toHaveLength(2),
    );

    page
      .querySelectorAll<HTMLInputElement>('.custodian__wizard-step input[type="radio"]')[1]!
      .click();
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "evicted-wizard-session",
      wizardAnswer: { stepId: "channel", value: "twitch" },
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("wizardAnswer");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("evicted-wizard-session");
    await waitForFast(() => expect(page.textContent).toContain("Fresh session ready."));
    expect(page.querySelector(".custodian__wizard-step")).toBeNull();
  });

  it("starts fresh without replaying an invalidated typed wizard cancel", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "evicted-cancel-session",
        reply: "Enter the token.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "token",
          type: "text",
          message: "Bot token",
          sensitive: true,
        },
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "No active OpenClaw chat session is awaiting that wizard cancel.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "replacement-session",
        reply: "Fresh session ready.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    const cancel = await waitForFast(() => {
      const button = page.querySelector<HTMLButtonElement>(".custodian__wizard-cancel");
      expect(button).not.toBeNull();
      return button!;
    });

    cancel.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "evicted-cancel-session",
      wizardCancel: { stepId: "token" },
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("wizardCancel");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("evicted-cancel-session");
    await waitForFast(() => expect(page.textContent).toContain("Fresh session ready."));
    expect(page.querySelector(".custodian__wizard-step")).toBeNull();
  });

  it("keeps the live session after an error that does not invalidate it", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "engine-session-that-survives",
        reply: "Welcome.",
        action: "none",
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Temporary request failure.",
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "engine-session-that-survives",
        reply: "Still together.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome."));

    await sendMessage(page, "first try");
    await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
    await sendMessage(page, "second try");

    await waitForFast(() => expect(page.textContent).toContain("Still together."));
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "engine-session-that-survives",
      message: "second try",
    });
  });

  it("stops after one rotation when the fresh session failure is also marked", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "engine-session-before-outage",
        reply: "Welcome.",
        action: "none",
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "The live session was lost.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Inference is still unavailable.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      );
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome."));

    await sendMessage(page, "status please");

    await waitForFast(() => expect(page.textContent).toContain("Inference is still unavailable."));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
  });
});
