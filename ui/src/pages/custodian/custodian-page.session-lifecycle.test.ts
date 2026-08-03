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
