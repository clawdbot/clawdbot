import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage lifecycle", () => {
  it.each(["publication", "agent", "connection", "gateway", "detach"])(
    "rejects a retired catalog result and error after %s changes",
    async (change) => {
      const oldResult = createDeferred<{ models: { id: string }[] }>();
      const oldError = createDeferred();
      const fallback = createRequest();
      let reads = 0;
      const client = createTestGatewayClient((method) => {
        if (method !== "models.list") {
          return fallback(method);
        }
        reads += 1;
        if (reads === 1) {
          return oldResult.promise;
        }
        if (reads === 2) {
          return oldError.promise;
        }
        return { models: [{ id: "current-model" }] };
      });
      const gateway = createGateway(client, true);
      const context = createContext(gateway);
      const page = createPage(context, { render: true });
      await waitForCronPage(() => expect(reads).toBe(1));
      gateway.emitRetiredEvent({ type: "event", event: "config.changed", payload: {} });
      await waitForCronPage(() => expect(reads).toBe(2));

      if (change === "agent") {
        context.agentSelection.set("writer");
      } else if (change === "connection") {
        gateway.emitSnapshot({ phase: "reconnecting" });
        gateway.emitSnapshot({ phase: "connected" });
      } else if (change === "gateway") {
        page.context = createContext(createGateway(client, true));
        page.requestUpdate();
      } else if (change === "detach") {
        page.remove();
      } else {
        gateway.emitRetiredEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      }
      const expected = change === "detach" ? [] : ["current-model"];
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(expected));
      oldResult.resolve({ models: [{ id: "retired-model" }] });
      oldError.reject(new Error("Retired catalog error"));
      await Promise.allSettled([oldResult.promise, oldError.promise]);
      await page.updateComplete;
      expect(page.cronModelSuggestions).toEqual(expected);
      expect(page.textContent).not.toContain("Retired catalog error");
    },
  );

  it("coalesces a cron event burst into one trailing refresh of the current page", async () => {
    const held = createDeferred();
    let released = false;
    const freshJob = createCronViewJob("fresh-job", {
      configRevision: "fresh-config",
      state: {},
    });
    const freshRun = {
      ts: 2,
      jobId: freshJob.id,
      action: "finished",
      status: "ok",
      summary: "Finished after the refresh started",
    };
    const request = vi.fn(async (method: string) => {
      const stale = !released;
      if (method.startsWith("cron.") || method === "channels.status") {
        await held.promise;
      }
      if (method === "cron.status") {
        return { enabled: true, triggersEnabled: true, jobs: stale ? 0 : 1 };
      }
      if (method === "cron.list") {
        return cronListResponse(stale ? [] : [freshJob]);
      }
      if (method === "cron.runs") {
        return { entries: stale ? [] : [freshRun], total: stale ? 0 : 1, hasMore: false };
      }
      if (method === "channels.status") {
        return { channelOrder: [], channels: {}, channelAccounts: {} };
      }
      return { models: [] };
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const channels = createChannelCapability(gateway);
    const context = { ...createContext(gateway), channels };
    const page = createPage(context);
    try {
      await page.updateComplete;
      for (let index = 0; index < 20; index += 1) {
        gateway.emitRetiredEvent({ event: "cron" } as never);
      }
      for (const method of ["cron.status", "cron.runs", "cron.list", "channels.status"]) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }

      released = true;
      held.resolve();
      await waitForCronPage(() => {
        expect(page.cron.cronStatus?.jobs).toBe(1);
        expect(page.cron.cronJobs).toEqual([freshJob]);
        expect(page.cron.cronRuns).toEqual([freshRun]);
      });
      for (const method of ["cron.status", "cron.runs", "cron.list"]) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(2);
      }
      expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
    } finally {
      page.remove();
      channels.dispose();
      released = true;
      held.resolve();
    }
  });

  it("lets manual Refresh supersede held status and run-history reads", async () => {
    const held = createDeferred();
    const calls = { "cron.status": 0, "cron.runs": 0 };
    const fallback = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method !== "cron.status" && method !== "cron.runs") {
        return fallback(method);
      }
      const revision = ++calls[method];
      if (revision === 1) {
        await held.promise;
      }
      return method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: revision }
        : {
            entries: [{ ts: revision, jobId: "job", action: "finished", status: "ok" }],
            total: 1,
            hasMore: false,
          };
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    try {
      await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
      await page.updateComplete;
      expect(calls).toEqual({ "cron.status": 1, "cron.runs": 1 });
      const refresh = page.querySelector<HTMLButtonElement>(".cron-refresh");
      expect(refresh).not.toBeNull();
      refresh?.click();
      expect(calls).toEqual({ "cron.status": 2, "cron.runs": 2 });
      await waitForCronPage(() => {
        expect(page.cron.cronStatus?.jobs).toBe(2);
        expect(page.cron.cronRuns[0]?.ts).toBe(2);
      });
      held.resolve();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(page.cron.cronStatus?.jobs).toBe(2);
      expect(page.cron.cronRuns[0]?.ts).toBe(2);
      expect(calls).toEqual({ "cron.status": 2, "cron.runs": 2 });
    } finally {
      page.remove();
      held.resolve();
    }
  });

  it.each(["disconnect", "reconnect", "agent scope", "gateway source", "unmount"])(
    "retires queued cron event refreshes on %s",
    async (change) => {
      const held = createDeferred();
      let hold = true;
      const fallback = createRequest();
      const request = vi.fn(async (method: string) => {
        if (hold && method.startsWith("cron.")) {
          await held.promise;
          if (method === "cron.status") {
            return { enabled: true, triggersEnabled: true, jobs: 99 };
          }
          if (method === "cron.list") {
            return cronListResponse([createCronViewJob("retired-job")]);
          }
          if (method === "cron.runs") {
            return {
              entries: [{ ts: 99, jobId: "retired-job", action: "finished", status: "ok" }],
              total: 1,
              hasMore: false,
            };
          }
        }
        return fallback(method);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const gateway = createGateway(client, true);
      const context = createContext(gateway);
      const page = createPage(context);
      try {
        await page.updateComplete;
        gateway.emitRetiredEvent({ event: "cron" } as never);
        hold = false;
        if (change === "disconnect" || change === "reconnect") {
          gateway.emitSnapshot({ phase: "stopped" });
          if (change === "reconnect") {
            gateway.emitSnapshot({ phase: "connected" });
          }
        } else if (change === "agent scope") {
          context.agentSelection.setScope("writer");
        } else if (change === "gateway source") {
          page.context = createContext(createGateway(client, true));
          page.requestUpdate();
        } else {
          page.remove();
        }
        await page.updateComplete;
        const count = request.mock.calls.length;
        held.resolve();
        // Let the retired read and its queued completion settle before checking dispatch.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        await page.updateComplete;
        expect(request).toHaveBeenCalledTimes(count);
        expect(page.cron.cronError).toBeNull();
        expect(page.cron.cronStatus?.jobs).not.toBe(99);
        expect(page.cron.cronJobs.some((job) => job.id === "retired-job")).toBe(false);
        expect(page.cron.cronRuns.some((run) => run.jobId === "retired-job")).toBe(false);
      } finally {
        page.remove();
        held.resolve();
      }
    },
  );

  it("registers idempotently when the module is evaluated again", async () => {
    const registered = customElements.get("openclaw-cron-page");
    expect(registered).toBeDefined();

    const freshModulePath = "./cron-page.ts?custom-element-idempotence";
    await expect(import(/* @vite-ignore */ freshModulePath)).resolves.toBeDefined();

    expect(customElements.get("openclaw-cron-page")).toBe(registered);
  });

  it("replaces all mutable page state on each connection epoch", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway));
    await page.updateComplete;
    const connectedState = page.cron;
    page.cron = {
      ...connectedState,
      cronStatus: { enabled: true, triggersEnabled: true, jobs: 1 },
      cronJobs: [{ id: "old" } as never],
      cronCreateOpen: true,
    };
    page.cronModelSuggestions = ["old/model"];

    gateway.emitSnapshot({ phase: "stopped" });
    const disconnectedState = page.cron;

    expect(disconnectedState).not.toBe(connectedState);
    expect(disconnectedState.cronStatus).toBeNull();
    expect(disconnectedState.cronJobs).toEqual([]);
    expect(page.cronModelSuggestions).toEqual([]);
    expect(disconnectedState.cronCreateOpen).toBe(false);

    gateway.emitSnapshot({ phase: "connected" });
    expect(page.cron).not.toBe(disconnectedState);
  });

  it("refreshes trigger authoring from scheduler status after reconnect", async () => {
    const schedulerStatus = { enabled: true, jobs: 0, triggersEnabled: true };
    const request = createRequest(schedulerStatus);
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const context = createContext(gateway);
    Object.assign(context.runtimeConfig.state, {
      configForm: { cron: { triggers: { enabled: true } } },
      configNeedsApply: true,
    });
    const page = createPage(context, { render: true });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: true }),
    );
    schedulerStatus.triggersEnabled = false;
    gateway.emitSnapshot({ phase: "stopped" });
    expect(page.cron.cronStatus).toBeNull();
    gateway.emitSnapshot({ phase: "connected" });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: false }),
    );
    expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(2);
    (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
    await waitForCronPage(() => expect(page.querySelector("fieldset.cron-editor")).not.toBeNull());

    const triggerToggle = Array.from(page.querySelectorAll("wa-switch.settings-toggle")).find(
      (toggle) => toggle.textContent?.includes("Condition trigger"),
    );
    expect(triggerToggle).toBeUndefined();
    expect(page.textContent).toContain("disabled by cron.triggers.enabled");
  });

  it("rejects model suggestions from an earlier connection epoch", async () => {
    const staleModels = createDeferred<{ models: Array<{ id: string }> }>();
    let modelRequestCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        modelRequestCount += 1;
        return modelRequestCount === 1 ? staleModels.promise : { models: [{ id: "fresh/model" }] };
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, false);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(modelRequestCount).toBe(1));
    gateway.emitSnapshot({ phase: "stopped" });
    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fresh/model"]));

    staleModels.resolve({ models: [{ id: "stale/model" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.cronModelSuggestions).toEqual(["fresh/model"]);
  });

  it("ignores a cron event callback retained by a replaced gateway source", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const firstGateway = createGateway(client, true);
    const secondGateway = createGateway(client, true);
    const firstContext = createContext(firstGateway);
    const secondContext = createContext(secondGateway);
    const page = createPage(firstContext);
    await waitForCronPage(() => expect(request).toHaveBeenCalled());

    page.context = secondContext;
    page.requestUpdate();
    await page.updateComplete;
    await waitForCronPage(() => expect(page.cron.client).toBe(client));
    request.mockClear();
    vi.mocked(secondContext.channels.refresh).mockClear();

    firstGateway.emitRetiredEvent({ event: "cron" } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(secondContext.channels.refresh).not.toHaveBeenCalled();
  });
});
