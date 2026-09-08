/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";
import { refreshControlUiServiceWorker } from "./sw-refresh.runtime.ts";

vi.mock("./stale-chunk-reload.ts", () => ({ scheduleStaleChunkReload: vi.fn() }));

beforeEach(() => {
  vi.mocked(scheduleStaleChunkReload).mockReset();
  vi.mocked(scheduleStaleChunkReload).mockImplementation(
    async (options) => options?.canReload?.() !== false,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createWorker(version = CONTROL_UI_BUILD_INFO.buildId) {
  return Object.assign(new EventTarget(), {
    state: "activated" as ServiceWorkerState,
    postMessage: vi.fn((_message: unknown, ports: MessagePort[]) => {
      ports[0]?.postMessage({ type: "sw-updated", version });
    }),
  });
}

function installRegistration(active = createWorker()) {
  const registration = {
    active: active as unknown as ServiceWorker,
    installing: null as ServiceWorker | null,
    waiting: null as ServiceWorker | null,
    update: vi.fn(async () => undefined),
  };
  vi.stubGlobal("navigator", {
    serviceWorker: { controller: active, getRegistration: async () => registration },
  });
  return registration;
}

describe("Control UI service-worker reconnect refresh", () => {
  it("recovers a document that missed the active worker's activation", async () => {
    const active = createWorker("already-active-build");
    const registration = installRegistration(active);
    // No second activation: the same worker already claimed this sleeping page.
    await expect(refreshControlUiServiceWorker()).resolves.toBe(true);
    expect(scheduleStaleChunkReload).toHaveBeenCalledOnce();
    expect(registration.update).toHaveBeenCalledOnce();
  });

  it.each(["discovered", "installing", "waiting"] as const)(
    "holds reconnect work until a %s replacement can identify its build",
    async (phase) => {
      const replacement = createWorker("next-build");
      replacement.state = "installing";
      const registration = installRegistration();
      if (phase === "discovered") {
        registration.update.mockImplementation(async () => {
          registration.installing = replacement as unknown as ServiceWorker;
        });
      } else {
        registration[phase] = replacement as unknown as ServiceWorker;
      }
      const listening = vi.spyOn(replacement, "addEventListener");
      let settled = false;
      const refresh = refreshControlUiServiceWorker().then((retired) => {
        settled = true;
        return retired;
      });
      await vi.waitFor(() => expect(listening).toHaveBeenCalled());
      expect(settled).toBe(false);
      expect(registration.update).toHaveBeenCalledTimes(phase === "discovered" ? 1 : 0);
      registration.active = replacement as unknown as ServiceWorker;
      registration.installing = null;
      registration.waiting = null;
      replacement.state = "activated";
      replacement.dispatchEvent(new Event("statechange"));
      await expect(refresh).resolves.toBe(true);
    },
  );

  it("releases reconnect work when activation serves the document's own build", async () => {
    const replacement = createWorker();
    replacement.state = "installing";
    const registration = installRegistration(createWorker("previous-build"));
    registration.installing = replacement as unknown as ServiceWorker;
    const listening = vi.spyOn(replacement, "addEventListener");
    const refresh = refreshControlUiServiceWorker();
    await vi.waitFor(() => expect(listening).toHaveBeenCalled());
    registration.active = replacement as unknown as ServiceWorker;
    replacement.state = "activated";
    replacement.dispatchEvent(new Event("statechange"));
    await expect(refresh).resolves.toBe(false);
    expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
  });

  it("does not hold reconnect work when document recovery declines the reload", async () => {
    const registration = installRegistration(createWorker("next-build"));
    vi.mocked(scheduleStaleChunkReload).mockResolvedValue(false);
    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
    expect(registration.update).toHaveBeenCalledOnce();
  });

  it("ignores an old worker reply after the registration moves to another build", async () => {
    const oldWorker = createWorker("old-worker");
    const registration = installRegistration(oldWorker);
    oldWorker.postMessage.mockImplementation((_message, ports) => {
      registration.active = createWorker() as unknown as ServiceWorker;
      ports[0]?.postMessage({ type: "sw-updated", version: "old-worker" });
    });
    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
    expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
  });

  it("reconciles the new active worker when it changes during an identity query", async () => {
    const oldWorker = createWorker();
    const replacement = createWorker("new-worker");
    const registration = installRegistration(oldWorker);
    oldWorker.postMessage.mockImplementation((_message, ports) => {
      registration.active = replacement as unknown as ServiceWorker;
      ports[0]?.postMessage({ type: "sw-updated", version: CONTROL_UI_BUILD_INFO.buildId });
    });
    await expect(refreshControlUiServiceWorker()).resolves.toBe(true);
    expect(replacement.postMessage).toHaveBeenCalledOnce();
  });

  it("recovers the active build even when the network update check fails", async () => {
    const registration = installRegistration(createWorker("already-active-build"));
    registration.update.mockRejectedValue(new Error("worker update unavailable"));
    await expect(refreshControlUiServiceWorker()).resolves.toBe(true);
    expect(scheduleStaleChunkReload).toHaveBeenCalledOnce();
  });

  it("bounds unanswered identity queries without holding reconnect work", async () => {
    vi.useFakeTimers();
    const worker = createWorker();
    worker.postMessage.mockImplementation(() => undefined);
    const registration = installRegistration(worker);
    const refresh = refreshControlUiServiceWorker();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(refresh).resolves.toBe(false);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases reconnect work when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
  });
});
