// Voice Call tests cover stale-call reaping through a real provider HTTP boundary.
import type { ServerResponse } from "node:http";
import { withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endCall } from "../manager/outbound.js";
import { TelnyxProvider } from "../providers/telnyx.js";
import type { CallRecord } from "../types.js";
import { startStaleCallReaper } from "./stale-call-reaper.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function waitForProofEvent<T>(promise: Promise<T>, label: string): Promise<T> {
  // AbortSignal.timeout stays real while this suite fakes the global timer functions.
  const timeoutSignal = AbortSignal.timeout(1_000);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`timed out waiting for ${label}`));
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        timeoutSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        timeoutSignal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

describe("stale-call reaper provider transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps one Telnyx hangup in flight, then retries after the provider timeout", async () => {
    vi.useFakeTimers({
      // Voice provider requests use buildTimeoutAbortSignal's setTimeout timer.
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));

    const firstRequestStarted = deferred<void>();
    const firstResponseClosed = deferred<void>();
    const secondRequestStarted = deferred<void>();
    const firstEndCallSettled = deferred<{ success: boolean; error?: string }>();
    const secondEndCallSettled = deferred<{ success: boolean; error?: string }>();
    let requestCount = 0;
    let firstResponse: ServerResponse | undefined;

    await withServer(
      (_req, res) => {
        requestCount += 1;
        if (requestCount === 1) {
          firstResponse = res;
          res.once("close", () => firstResponseClosed.resolve());
          firstRequestStarted.resolve();
          return;
        }
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("controlled provider failure");
        secondRequestStarted.resolve();
      },
      async (baseUrl) => {
        const realFetch = globalThis.fetch.bind(globalThis);
        const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const providerUrl = new URL(input instanceof Request ? input.url : String(input));
          const loopbackUrl = new URL(`${providerUrl.pathname}${providerUrl.search}`, baseUrl);
          return await realFetch(loopbackUrl, init);
        });
        vi.stubGlobal("fetch", withFetchPreconnect(transport));

        const provider = new TelnyxProvider({
          apiKey: "KEY123",
          connectionId: "connection-test",
        });
        const call = {
          callId: "call-stale",
          providerCallId: "provider-stale",
          provider: "telnyx",
          direction: "outbound",
          from: "+10000000001",
          to: "+10000000002",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
          transcript: [],
          processedEventIds: [],
        } satisfies CallRecord;
        const context: Parameters<typeof endCall>[0] = {
          activeCalls: new Map([[call.callId, call]]),
          providerCallIdMap: new Map([[call.providerCallId, call.callId]]),
          provider,
          storePath: "/tmp/openclaw-voice-call-proof.json",
          transcriptWaiters: new Map(),
          maxDurationTimers: new Map(),
        };
        let settlementCount = 0;
        const manager = {
          getActiveCalls: () => [...context.activeCalls.values()],
          endCall: vi.fn(async (callId: string) => {
            const settlement = settlementCount++ === 0 ? firstEndCallSettled : secondEndCallSettled;
            try {
              const result = await endCall(context, callId);
              settlement.resolve(result);
              return result;
            } catch (error) {
              settlement.reject(error);
              throw error;
            }
          }),
        };

        const stop = startStaleCallReaper({
          manager,
          staleCallReaperSeconds: 60,
        });

        await vi.advanceTimersByTimeAsync(30_000);
        await waitForProofEvent(firstRequestStarted.promise, "the first provider request");
        expect(requestCount).toBe(1);

        // The next sweep coincides with the provider's 30s request timeout. It must
        // not start another hangup before the first attempt has settled.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(requestCount).toBe(1);
        expect(manager.endCall).toHaveBeenCalledTimes(1);
        expect(firstResponse).toBeDefined();

        const firstResult = await waitForProofEvent(
          firstEndCallSettled.promise,
          "the first endCall settlement",
        );
        await waitForProofEvent(firstResponseClosed.promise, "the timed-out socket close");
        expect(firstResult).toEqual({ success: false, error: "request timed out" });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(30_000);
        await waitForProofEvent(secondRequestStarted.promise, "the retried provider request");
        const secondResult = await waitForProofEvent(
          secondEndCallSettled.promise,
          "the retried endCall settlement",
        );

        expect(requestCount).toBe(2);
        expect(manager.endCall).toHaveBeenCalledTimes(2);
        expect(secondResult).toEqual({
          success: false,
          error: "Telnyx API error: 503 controlled provider failure",
        });
        expect(transport).toHaveBeenCalledTimes(2);

        stop?.();
      },
    );
  });
});
