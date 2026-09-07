import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import "./cron-page.ts";

const refreshMethods = ["cron.status", "cron.list", "cron.runs"];

function controlVisibility(initial: DocumentVisibilityState = "visible") {
  let value = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => value);
  return (next: DocumentVisibilityState) => {
    value = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

function settle() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage hidden refreshes", () => {
  it("defers a hidden mount and reconnect, then catches up once with the current scope", async () => {
    const visibility = controlVisibility("hidden");
    const request = createRequest();
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const context = createContext(gateway);
    const page = createPage(context);
    await page.updateComplete;
    gateway.emitSnapshot({ phase: "stopped" });
    context.agentSelection.setScope("writer");
    gateway.emitSnapshot({ phase: "connected" });
    for (let event = 0; event < 20; event += 1) {
      gateway.emitRetiredEvent({ event: "cron" } as never);
    }
    await settle();
    expect(request.mock.calls.filter(([method]) => refreshMethods.includes(method))).toEqual([]);
    expect(context.channels.refresh).not.toHaveBeenCalled();

    visibility("visible");
    globalThis.dispatchEvent(new Event("focus"));
    await waitForCronPage(() => expect(page.cron.cronStatus).not.toBeNull());
    await settle();
    for (const method of refreshMethods) {
      expect(
        request.mock.calls.filter(([called]) => called === method),
        method,
      ).toHaveLength(1);
    }
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(context.channels.refresh).toHaveBeenCalledTimes(1);
    page.remove();
    request.mockClear();
    visibility("hidden");
    visibility("visible");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps a queued burst paused when its reads finish while hidden=%s",
    async (finishHidden) => {
      const visibility = controlVisibility();
      const held = createDeferred();
      let hold = true;
      const fallback = createRequest();
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (hold && refreshMethods.includes(method)) {
          await held.promise;
        }
        return fallback(method);
      });
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      const page = createPage(createContext(gateway));
      try {
        await page.updateComplete;
        const current = page.cron;
        current.cronJobsQuery = "keep my filter";
        current.cronCreateOpen = true;
        current.cronForm.name = "Unsaved automation";
        for (let event = 0; event < 20; event += 1) {
          gateway.emitRetiredEvent({ event: "cron" } as never);
        }
        visibility("hidden");
        current.cronRunsQuery = "keep my history filter";
        hold = false;
        if (finishHidden) {
          held.resolve();
          await settle();
        }
        for (const method of refreshMethods) {
          expect(
            request.mock.calls.filter(([called]) => called === method),
            method,
          ).toHaveLength(1);
        }
        visibility("visible");
        globalThis.dispatchEvent(new Event("focus"));
        held.resolve();
        await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
        await settle();
        for (const method of refreshMethods) {
          expect(
            request.mock.calls.filter(([called]) => called === method),
            method,
          ).toHaveLength(2);
        }
        expect(page.cron).toBe(current);
        expect(current.cronCreateOpen).toBe(true);
        expect(current.cronForm.name).toBe("Unsaved automation");
        expect(
          request.mock.calls.findLast(([method]) => method === "cron.list")?.[1],
        ).toMatchObject({ query: "keep my filter" });
        expect(
          request.mock.calls.findLast(([method]) => method === "cron.runs")?.[1],
        ).toMatchObject({ query: "keep my history filter" });
      } finally {
        held.resolve();
        page.remove();
      }
    },
  );

  it("rebinds hidden catch-up to the replacement Gateway", async () => {
    const visibility = controlVisibility();
    const held = createDeferred();
    const fallback = createRequest();
    const oldRequest = vi.fn(async (method: string) => {
      if (refreshMethods.includes(method)) {
        await held.promise;
      }
      return fallback(method);
    });
    const oldGateway = createGateway(
      { request: oldRequest } as unknown as GatewayBrowserClient,
      true,
    );
    const page = createPage(createContext(oldGateway));
    try {
      await page.updateComplete;
      oldGateway.emitRetiredEvent({ event: "cron" } as never);
      visibility("hidden");
      const request = createRequest();
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      page.context = createContext(gateway, "writer");
      page.requestUpdate();
      await page.updateComplete;
      held.resolve();
      await settle();
      expect(request).not.toHaveBeenCalled();
      for (const method of refreshMethods) {
        expect(
          oldRequest.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }
      oldRequest.mockClear();
      visibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      oldGateway.emitRetiredEvent({ event: "cron" } as never);
      await settle();
      for (const method of refreshMethods) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }
      expect(oldRequest).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith(
        "cron.list",
        expect.objectContaining({ agentId: "writer" }),
      );
    } finally {
      held.resolve();
      page.remove();
    }
  });

  it("finishes an accepted create-and-run chain while hidden without background readbacks", async () => {
    const visibility = controlVisibility();
    const saved = createDeferred();
    const fallback = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "cron.add") {
        await saved.promise;
        return { id: "created-job" };
      }
      if (method === "cron.run") {
        return { ok: true, enqueued: true, runId: "synthetic-run" };
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    try {
      await waitForCronPage(() => expect(page.cron.cronStatus).not.toBeNull());
      (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
      await page.updateComplete;
      for (const [selector, value] of [
        ["#cron-name", "Synthetic task"],
        ["#cron-payload-text", "Synthetic prompt"],
      ] as const) {
        const input = page.querySelector(selector) as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await page.updateComplete;
      (page.querySelector('[data-test-id="cron-submit-run"]') as HTMLButtonElement).click();
      await waitForCronPage(() =>
        expect(request.mock.calls.some(([method]) => method === "cron.add")).toBe(true),
      );
      visibility("hidden");
      request.mockClear();
      saved.resolve();
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      expect(request).toHaveBeenCalledExactlyOnceWith("cron.run", {
        id: "created-job",
        mode: "force",
      });
      expect(page.cron.cronError).toContain("Run queued. Run ID: synthetic-run");
      expect(page.cron.cronCreateOpen).toBe(false);
      visibility("visible");
      await settle();
      for (const method of refreshMethods) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }
    } finally {
      saved.resolve();
      page.remove();
    }
  });
});
