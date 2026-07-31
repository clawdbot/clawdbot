import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdpModule from "./cdp.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("browser tab ownership probes", () => {
  it("propagates caller abort through the managed ownership version probe", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "CREATED",
      finalUrl: "http://127.0.0.1:8080",
    });
    let versionSignal: AbortSignal | undefined;
    let closedCreatedTarget = false;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        return {
          ok: true,
          json: async () => [
            {
              id: "CREATED",
              title: "New Tab",
              url: "http://127.0.0.1:8080",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      if (value.includes("/json/version")) {
        versionSignal = init?.signal ?? undefined;
        markProbeStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new Error("managed ownership probe aborted"),
              ),
            { once: true },
          );
        });
      }
      if (value.includes("/json/close/CREATED")) {
        closedCreatedTarget = true;
        return { ok: true } as Response;
      }
      throw new Error(`unexpected fetch: ${value}`);
    });
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );
    const controller = new AbortController();
    const abortError = new Error("caller aborted managed ownership probe");

    const opening = openclaw.openTab("http://127.0.0.1:8080", {
      signal: controller.signal,
    });
    await probeStarted;
    controller.abort(abortError);
    const propagatedImmediately = versionSignal?.aborted;

    await expect(opening).rejects.toBe(abortError);
    expect(propagatedImmediately).toBe(true);
    expect(closedCreatedTarget).toBe(true);
  });
});
