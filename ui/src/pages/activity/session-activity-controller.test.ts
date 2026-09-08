// @vitest-environment node
import { expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { SessionActivityController } from "./session-activity-controller.ts";

it("keeps the same-query snapshot during invalidation and clears it on person changes", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const result = {
    ts: 1,
    path: "",
    count: 0,
    sessions: [],
    defaults: { model: null, modelProvider: null, contextTokens: null },
    involvingProfileId: "current",
  };
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });
  const filters = { personId: "former", time: "all" as const, query: "" };
  controller.load(client, filters);
  await vi.waitFor(() => expect(controller.result).toEqual(result));
  controller.load(client, filters, "refresh");
  expect(controller.result).toEqual(result);
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({ involvingProfileId: "former", includePeople: true }),
    expect.anything(),
  );
  controller.load(client, { ...filters, personId: "other" });
  expect(controller.result).toBeUndefined();
  controller.hostDisconnected();
});

it("holds a trailing Activity refresh through page hiding and retires it on disconnect", async () => {
  vi.useFakeTimers();
  const documentEvents = new EventTarget();
  const pageEvents = new EventTarget();
  let visibilityState = "visible";
  Object.defineProperty(documentEvents, "visibilityState", { get: () => visibilityState });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  const result = {
    ts: 1,
    path: "",
    count: 0,
    sessions: [],
    defaults: { model: null, modelProvider: null, contextTokens: null },
  };
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  let complete!: (value: typeof result) => void;
  const pending = new Promise<typeof result>((resolve) => {
    complete = resolve;
  });
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });
  try {
    controller.hostConnected();
    const filters = { personId: null, time: "7d" as const, query: "" };
    controller.load(client, filters);
    await vi.advanceTimersByTimeAsync(0);
    request.mockReturnValueOnce(pending);
    controller.load(client, filters, "refresh");
    controller.invalidate();
    await vi.advanceTimersByTimeAsync(200);
    visibilityState = "hidden";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    complete(result);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    visibilityState = "visible";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    pageEvents.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    controller.invalidate();
    controller.hostDisconnected();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    complete(result);
    controller.hostDisconnected();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
