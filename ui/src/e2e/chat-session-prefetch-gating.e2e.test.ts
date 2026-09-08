// Control UI E2E: background session warming must never share the socket with the
// transcript the user is looking at, including a reload that a Gateway event starts
// inside the pane itself, where nothing re-renders the page.
import { expect, it } from "vitest";
import {
  installMockGateway,
  pauseVirtualClock,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat session prefetch gating",
  startServerBeforeBrowser: true,
});

const MAIN_SESSION_KEY = "agent:main:main";
const WARM_SESSION_KEY = "agent:main:warm-later";
const CLOCK_START = Date.UTC(2026, 8, 3, 12, 0, 0);

function transcript(text: string, seq: number) {
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: CLOCK_START - 60_000 + seq,
        __openclaw: { id: `msg-${seq}`, seq },
      },
    ],
  };
}

async function historyRequestCount(
  gateway: MockGatewayControls,
  sessionKey: string,
): Promise<number> {
  const requests = await gateway.getRequests("chat.history");
  return requests.filter(
    (request) => (request.params as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  ).length;
}

suite.define(() => {
  it("keeps queued warm-ups off the socket while the presented transcript reloads", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.clock.install({ time: CLOCK_START });
    const mainSession = createControlUiSessionRow(MAIN_SESSION_KEY, "Main", CLOCK_START - 1_000);
    const gateway = await installMockGateway(page, {
      // The presented pane boots through chat.startup, so the first chat.history
      // on the wire is the background warm-up of the other session.
      deferredMethods: ["chat.history"],
      historyMessages: [],
      sessions: [
        mainSession,
        createControlUiSessionRow(WARM_SESSION_KEY, "Warm later", CLOCK_START - 2_000),
      ],
      sessionTranscripts: {
        [MAIN_SESSION_KEY]: transcript("Main transcript", 1),
        [WARM_SESSION_KEY]: transcript("Warm transcript", 2),
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.locator(".chat-bubble", { hasText: "Main transcript" }).first().waitFor();
      await expect.poll(() => historyRequestCount(gateway, WARM_SESSION_KEY)).toBe(1);
      // A failed warm-up leaves the session eligible and arms the prefetcher's own
      // cooldown retry timer, which fires without any page update in between.
      // Not retryable: the Gateway client would otherwise re-issue the request itself.
      await gateway.rejectDeferred("chat.history", { code: "UNAVAILABLE", message: "warm later" });

      // A peer message makes the presented pane reload its transcript from inside
      // the pane; hold that reload on the wire.
      await gateway.deferNext("chat.history", { sessionKey: MAIN_SESSION_KEY });
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: MAIN_SESSION_KEY,
        session: mainSession,
        message: {
          role: "user",
          content: [{ type: "text", text: "Peer message arrived." }],
          __openclaw: { id: "peer-message", seq: 5 },
        },
        messageId: "peer-message",
        messageSeq: 5,
      });
      await expect.poll(() => historyRequestCount(gateway, MAIN_SESSION_KEY)).toBe(1);

      // Fire every prefetch timer, including the cooldown retry, while the
      // presented transcript is still in flight.
      await pauseVirtualClock(page);
      await page.clock.runFor(35_000);
      expect(await historyRequestCount(gateway, WARM_SESSION_KEY)).toBe(1);

      // Once the presented transcript commits, warming resumes on its own.
      await gateway.resolveDeferred("chat.history", {
        ...transcript("Main transcript reloaded", 6),
        sessionId: mainSession.sessionId,
      });
      await page.locator(".chat-bubble", { hasText: "Main transcript reloaded" }).first().waitFor();
      await page.clock.runFor(35_000);
      await expect.poll(() => historyRequestCount(gateway, WARM_SESSION_KEY)).toBe(2);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
