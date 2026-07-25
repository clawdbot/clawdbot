import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  askLogbook,
  configureLogbookPolling,
  getLogbookState,
  loadLogbook,
  loadLogbookStandup,
  runLogbookAnalysisNow,
  setLogbookCapturePaused,
  stopLogbookPolling,
} from "./logbook-controller.ts";
import type { LogbookStatusPayload } from "./logbook-types.ts";

function clientWithRequest(
  request: (method: string, params: unknown) => Promise<unknown>,
): GatewayBrowserClient {
  return { request } as GatewayBrowserClient;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function statusFor(day: string): LogbookStatusPayload {
  return {
    captureEnabled: true,
    capturePaused: false,
    captureIntervalSeconds: 30,
    analysisIntervalMinutes: 15,
    retentionDays: 30,
    pendingFrames: 0,
    analysisRunning: false,
    visionModelSource: "missing",
    today: day,
    todayCards: 1,
    timeZone: "UTC",
  };
}

function timelineFor(day: string, title: string) {
  return {
    day,
    cards: [
      {
        id: 1,
        day,
        startMs: 1,
        endMs: 2,
        title,
        summary: "Summary",
        detail: "",
        category: "Coding",
        distractions: [],
      },
    ],
    stats: { trackedMs: 1, distractionMs: 0, categories: [], apps: [] },
  };
}

describe("Logbook controller", () => {
  const hosts: object[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) {
      stopLogbookPolling(host);
    }
    vi.useRealTimers();
  });

  it("lets an in-flight load settle after polling stops", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const responses = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const client = clientWithRequest(
      (method) =>
        responses.get(method)?.promise ?? Promise.reject(new Error(`Unexpected ${method}`)),
    );
    configureLogbookPolling(state, client, true);
    const request = loadLogbook(state, client);

    stopLogbookPolling(host);
    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Detached host"));
    await request;

    expect(state.timeline?.cards[0]?.title).toBe("Detached host");
    expect(state.pollTimer).toBeNull();
  });

  it("does not overlap silent poll refreshes and resumes after settlement", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const firstBatch = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const request = vi.fn((method: string) => {
      const pending = firstBatch.get(method);
      if (pending) {
        firstBatch.delete(method);
        return pending.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "Resumed poll"));
    });

    configureLogbookPolling(state, clientWithRequest(request), true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(request).toHaveBeenCalledTimes(3);

    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "First poll"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.timeline?.cards[0]?.title).toBe("First poll");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.filter(([method]) => method === "logbook.status")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "logbook.days")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "logbook.timeline")).toHaveLength(2);
    expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
  });

  it("retires silent refresh ownership while polling is inactive", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const staleStatus = deferred<unknown>();
    const staleDays = deferred<unknown>();
    const staleTimeline = deferred<unknown>();
    const staleBatch = new Map([
      ["logbook.status", staleStatus],
      ["logbook.days", staleDays],
      ["logbook.timeline", staleTimeline],
    ]);
    const request = vi.fn((method: string) => {
      const stale = staleBatch.get(method);
      if (stale) {
        staleBatch.delete(method);
        return stale.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "Reactivated poll"));
    });
    const client = clientWithRequest(request);

    configureLogbookPolling(state, client, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);

    configureLogbookPolling(state, null, false);
    configureLogbookPolling(state, client, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(6);
    expect(state.timeline?.cards[0]?.title).toBe("Reactivated poll");

    staleStatus.resolve(statusFor("2026-07-04"));
    staleDays.resolve({ days: [] });
    staleTimeline.resolve(timelineFor("2026-07-04", "Inactive poll"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.timeline?.cards[0]?.title).toBe("Reactivated poll");
  });

  it("shares the background refresh owner with analysis completion", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const pending = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const request = vi.fn((method: string) => {
      if (method === "logbook.analyze.now") {
        return Promise.resolve({ started: true });
      }
      const response = pending.get(method);
      if (response) {
        pending.delete(method);
        return response.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "Resumed poll"));
    });
    const client = clientWithRequest(request);

    configureLogbookPolling(state, client, true);
    await runLogbookAnalysisNow(state, client);
    expect(request).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);

    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Analysis refresh"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.timeline?.cards[0]?.title).toBe("Analysis refresh");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(7);
    expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
  });

  it("retires action ownership when the polling client changes", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const oldAnalysis = deferred<unknown>();
    const newAnalysis = deferred<unknown>();
    const oldClient = clientWithRequest(() => oldAnalysis.promise);
    const newClient = clientWithRequest((method) => {
      if (method === "logbook.analyze.now") {
        return newAnalysis.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "New client"));
    });

    configureLogbookPolling(state, oldClient, true);
    const oldRequest = runLogbookAnalysisNow(state, oldClient);
    expect(state.actionPending).toBe(true);

    configureLogbookPolling(state, newClient, true);
    expect(state.actionPending).toBe(false);
    const newRequest = runLogbookAnalysisNow(state, newClient);
    expect(state.actionPending).toBe(true);

    oldAnalysis.resolve({ started: true });
    await oldRequest;
    expect(state.actionPending).toBe(true);

    newAnalysis.resolve({ started: true });
    await newRequest;
    expect(state.actionPending).toBe(false);
  });

  it("discards a capture result from a retired polling client", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    const oldStatus = deferred<unknown>();
    const oldClient = clientWithRequest(() => oldStatus.promise);
    const newStatus = { ...statusFor("2026-07-05"), capturePaused: true };
    const newClient = clientWithRequest(() => Promise.resolve(newStatus));

    configureLogbookPolling(state, oldClient, true);
    const oldRequest = setLogbookCapturePaused(state, oldClient, true);
    configureLogbookPolling(state, newClient, true);
    await setLogbookCapturePaused(state, newClient, true);
    expect(state.status).toEqual(newStatus);

    oldStatus.resolve(statusFor("2026-07-04"));
    await oldRequest;
    expect(state.status).toEqual(newStatus);
    expect(state.actionPending).toBe(false);
  });

  it("queues an analysis refresh behind an in-flight poll", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const pending = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const request = vi.fn((method: string) => {
      if (method === "logbook.analyze.now") {
        return Promise.resolve({ started: true });
      }
      const response = pending.get(method);
      if (response) {
        pending.delete(method);
        return response.promise;
      }
      if (method === "logbook.status") {
        return Promise.resolve(statusFor("2026-07-04"));
      }
      if (method === "logbook.days") {
        return Promise.resolve({ days: [] });
      }
      return Promise.resolve(timelineFor("2026-07-04", "Post-analysis refresh"));
    });
    const client = clientWithRequest(request);

    configureLogbookPolling(state, client, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);

    await runLogbookAnalysisNow(state, client);
    expect(request).toHaveBeenCalledTimes(4);

    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Pre-analysis refresh"));
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(7);
    expect(state.timeline?.cards[0]?.title).toBe("Post-analysis refresh");
  });

  it("drops a queued analysis refresh when polling stops", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.dayPinned = true;
    const status = deferred<unknown>();
    const days = deferred<unknown>();
    const timeline = deferred<unknown>();
    const pending = new Map([
      ["logbook.status", status],
      ["logbook.days", days],
      ["logbook.timeline", timeline],
    ]);
    const request = vi.fn((method: string) => {
      if (method === "logbook.analyze.now") {
        return Promise.resolve({ started: true });
      }
      const response = pending.get(method);
      if (!response) {
        throw new Error(`Unexpected refresh request: ${method}`);
      }
      pending.delete(method);
      return response.promise;
    });
    const client = clientWithRequest(request);

    configureLogbookPolling(state, client, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);
    await runLogbookAnalysisNow(state, client);
    expect(request).toHaveBeenCalledTimes(4);

    stopLogbookPolling(host);
    status.resolve(statusFor("2026-07-04"));
    days.resolve({ days: [] });
    timeline.resolve(timelineFor("2026-07-04", "Detached host"));
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(4);
    expect(state.timeline?.cards[0]?.title).toBe("Detached host");
  });

  it("does not let an older day load overwrite a newer selection", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    const oldStatus = deferred<unknown>();
    const oldDays = deferred<unknown>();
    const oldTimeline = deferred<unknown>();
    const oldResponses = new Map([
      ["logbook.status", oldStatus],
      ["logbook.days", oldDays],
      ["logbook.timeline", oldTimeline],
    ]);
    const oldRequest = vi.fn((method: string) => {
      const response = oldResponses.get(method);
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return response.promise;
    });
    const newerRequest = vi.fn(async (method: string) => {
      if (method === "logbook.status") {
        return statusFor("2026-07-05");
      }
      if (method === "logbook.days") {
        return { days: [{ day: "2026-07-05", cards: 1, firstMs: 1, lastMs: 2 }] };
      }
      return timelineFor("2026-07-05", "New day");
    });

    const oldClient = clientWithRequest(oldRequest);
    const newClient = clientWithRequest(newerRequest);
    configureLogbookPolling(state, oldClient, true);
    const olderLoad = loadLogbook(state, oldClient, { day: "2026-07-04" });
    expect(oldRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-04" });

    configureLogbookPolling(state, newClient, true);
    await loadLogbook(state, newClient, { day: "2026-07-05" });
    expect(newerRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-05" });
    expect(state.timeline?.cards[0]?.title).toBe("New day");

    oldStatus.resolve(statusFor("2026-07-04"));
    oldDays.resolve({ days: [{ day: "2026-07-04", cards: 1, firstMs: 1, lastMs: 2 }] });
    oldTimeline.resolve(timelineFor("2026-07-04", "Old day"));
    await olderLoad;

    expect(state.day).toBe("2026-07-05");
    expect(state.status?.today).toBe("2026-07-05");
    expect(state.days[0]?.day).toBe("2026-07-05");
    expect(state.timeline?.cards[0]?.title).toBe("New day");
    expect(state.loading).toBe(false);
  });

  it("discards a standup response after the selected day changes", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    const pending = deferred<unknown>();
    const client = clientWithRequest(() => pending.promise);
    configureLogbookPolling(state, client, true);
    const request = loadLogbookStandup(state, client, false);

    state.day = "2026-07-05";
    pending.resolve({ day: "2026-07-04", text: "Old day", updatedMs: 1 });
    await request;

    expect(state.standup).toBeNull();
  });

  it("discards an ask response after the selected day changes", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.askQuestion = "What did I do?";
    const pending = deferred<unknown>();
    const client = clientWithRequest(() => pending.promise);
    configureLogbookPolling(state, client, true);
    const request = askLogbook(state, client);

    state.day = "2026-07-05";
    pending.resolve({ answer: "Old day" });
    await request;

    expect(state.askAnswer).toBeNull();
  });
});
