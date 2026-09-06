import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdpModule from "./cdp.js";
import { OPEN_TAB_DISCOVERY_POLL_MS } from "./server-context.constants.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition, markBrowserRuntimeStopping } from "./server-context.lifecycle.js";
import { makeState, originalFetch } from "./server-context.remote-tab-ops.harness.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import type { ProfileRuntimeState } from "./server-context.types.js";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition did not settle");
}

function makeProfileRuntime(): ProfileRuntimeState {
  return {
    profile: {
      name: "openclaw",
      cdpPort: 18800,
      cdpUrl: "http://127.0.0.1:18800",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      color: "#FF4500",
      driver: "openclaw",
      headless: true,
      headlessSource: "config",
      attachOnly: false,
    },
    running: { pid: 1234, proc: { on: vi.fn() } },
    lastTargetId: null,
  } as unknown as ProfileRuntimeState;
}

describe("browser tab discovery poll abort", () => {
  it("cancels the selection discovery timer", async () => {
    vi.useFakeTimers();
    const runtime = makeProfileRuntime();
    const tabWithoutWsUrl = {
      targetId: "PAGE",
      title: "page",
      url: "http://127.0.0.1:3001",
      type: "page" as const,
    };
    const listTabs = vi.fn(async () => [tabWithoutWsUrl]);

    const ops = createProfileSelectionOps({
      profile: runtime.profile,
      runtime,
      getCdpControlPolicy: () => undefined,
      listTabs,
      openTab: async () => tabWithoutWsUrl,
    });

    const controller = new AbortController();
    const ensurePromise = ops.ensureTabAvailable(undefined, { signal: controller.signal });

    await flushUntil(() => vi.getTimerCount() === 1);
    controller.abort();

    await expect(ensurePromise).rejects.toThrow(/aborted/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when an in-flight tab read succeeds after abort", async () => {
    vi.useFakeTimers();
    const runtime = makeProfileRuntime();
    const tab = {
      targetId: "PAGE",
      title: "page",
      url: "http://127.0.0.1:3001",
      wsUrl: "ws://127.0.0.1/devtools/page/PAGE",
      type: "page" as const,
    };
    let resolveFirstRead!: (tabs: (typeof tab)[]) => void;
    const firstRead = new Promise<(typeof tab)[]>((resolve) => {
      resolveFirstRead = resolve;
    });
    const listTabs = vi
      .fn()
      .mockImplementationOnce(async () => await firstRead)
      .mockResolvedValue([tab]);
    const ops = createProfileSelectionOps({
      profile: runtime.profile,
      runtime,
      getCdpControlPolicy: () => undefined,
      listTabs,
      openTab: async () => tab,
    });
    const controller = new AbortController();
    const ensurePromise = ops.ensureTabAvailable(undefined, { signal: controller.signal });

    await flushUntil(() => listTabs.mock.calls.length === 1);
    controller.abort();
    resolveFirstRead([tab]);

    await expect(ensurePromise).rejects.toThrow(/aborted/i);
    expect(listTabs).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { closeFails: false, shutdown: false },
    { closeFails: true, shutdown: false },
    { closeFails: false, shutdown: true },
  ])(
    "cancels opened-target discovery and closes the target (close fails: $closeFails, shutdown: $shutdown)",
    async ({ closeFails, shutdown }) => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
        targetId: "PENDING",
        finalUrl: "about:blank",
      });
      const closeRequests: string[] = [];
      const closeSignalsAborted: Array<boolean | undefined> = [];
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("/json/close/")) {
          closeRequests.push(String(url));
          closeSignalsAborted.push(init?.signal?.aborted);
          if (closeFails) {
            throw new Error("close request failed");
          }
          return { ok: true } as Response;
        }
        if (!String(url).includes("/json/list")) {
          throw new Error(`unexpected fetch: ${String(url)}`);
        }
        return { ok: true, json: async () => [] } as unknown as Response;
      });
      globalThis.fetch = withBrowserFetchPreconnect(fetchMock);
      const state = makeState("openclaw");
      const openclaw = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
      const controller = new AbortController();
      const openPromise = openclaw.openTab("about:blank", { signal: controller.signal });

      await vi.advanceTimersByTimeAsync(0);
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === OPEN_TAB_DISCOVERY_POLL_MS)).toBe(
        true,
      );
      expect(vi.getTimerCount()).toBe(1);
      let stopping: Promise<unknown> | undefined;
      if (shutdown) {
        markBrowserRuntimeStopping(state);
        stopping = beginProfileTransition({
          state,
          runtime: state.profiles.get("openclaw")!,
          reason: "runtime shutdown",
          closeSharedAdapters: false,
        });
      } else {
        controller.abort();
      }

      await expect(openPromise).rejects.toMatchObject({ name: "AbortError", message: "aborted" });
      expect(closeRequests).toEqual(["http://127.0.0.1:18800/json/close/PENDING"]);
      expect(closeSignalsAborted).toEqual([false]);
      await stopping;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
