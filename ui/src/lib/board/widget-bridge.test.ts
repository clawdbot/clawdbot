import { describe, expect, it, vi } from "vitest";
import { BoardWidgetBridgeController } from "./widget-bridge.ts";

type BoardWidgetBridgeRequest = Parameters<BoardWidgetBridgeController["handle"]>[0];

function request(method: string, params: Record<string, unknown>): BoardWidgetBridgeRequest {
  return {
    type: "openclaw:widget-bridge-request",
    id: crypto.randomUUID(),
    method,
    params,
    ticket: "ticket",
  };
}

function setup(
  options: {
    confirmationRequired?: boolean;
    omitPromptDecision?: boolean;
    now?: () => number;
  } = {},
) {
  const client = {
    request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
      async (method) =>
        method === "board.prompt.authorize"
          ? options.omitPromptDecision
            ? {}
            : { confirmationRequired: options.confirmationRequired === true }
          : { ok: true },
    ),
  };
  const confirmPrompt = vi.fn(() => true);
  const dispatchPrompt = vi.fn(() => true);
  const controller = new BoardWidgetBridgeController({
    frame: document.createElement("iframe"),
    ticket: "ticket",
    client,
    rateKey: "widget",
    confirmPrompt,
    dispatchPrompt,
    now: options.now,
  });
  return { client, confirmPrompt, dispatchPrompt, controller };
}

describe("board widget bridge", () => {
  it("asks for per-click confirmation when prompt is not granted", async () => {
    const { controller, confirmPrompt, dispatchPrompt } = setup({ confirmationRequired: true });

    await controller.handle(request("prompt.send", { text: "Show details" }), {
      promptUserActivated: true,
    });

    expect(dispatchPrompt).toHaveBeenCalledWith(
      expect.any(HTMLIFrameElement),
      "Show details",
      "widget",
      confirmPrompt,
    );
  });

  it("skips the prompt confirmation callback only when granted", async () => {
    const { controller, confirmPrompt, dispatchPrompt } = setup();

    await controller.handle(request("prompt.send", { text: "Show details" }), {
      promptUserActivated: true,
    });

    expect(confirmPrompt).not.toHaveBeenCalled();
    expect(dispatchPrompt).toHaveBeenCalledWith(
      expect.any(HTMLIFrameElement),
      "Show details",
      "widget",
      undefined,
    );
  });

  it("keeps confirmation when the authorization response omits its decision", async () => {
    const { controller, confirmPrompt, dispatchPrompt } = setup({ omitPromptDecision: true });

    await controller.handle(request("prompt.send", { text: "Show details" }), {
      promptUserActivated: true,
    });

    expect(dispatchPrompt).toHaveBeenCalledWith(
      expect.any(HTMLIFrameElement),
      "Show details",
      "widget",
      confirmPrompt,
    );
  });

  it("rejects a forged prompt bridge request without trusted user activation", async () => {
    const { controller, client, dispatchPrompt } = setup();

    await expect(controller.handle(request("prompt.send", { text: "Forged" }))).rejects.toThrow(
      "active user interaction",
    );

    expect(client.request).not.toHaveBeenCalled();
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });

  it("cancels prompt dispatch when the widget identity changes during authorization", async () => {
    const { controller, client, dispatchPrompt } = setup();
    let resolveAuthorization: (value: unknown) => void = () => {};
    client.request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    let current = true;
    const handling = controller.handle(request("prompt.send", { text: "Stale prompt" }), {
      promptUserActivated: true,
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());

    current = false;
    resolveAuthorization({ confirmationRequired: false });

    await expect(handling).rejects.toThrow("no longer current");
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });

  it("coalesces identical state payloads for five seconds", async () => {
    let nowMs = 1_000;
    const { controller, client } = setup({ now: () => nowMs });

    await controller.handle(request("state.emit", { payload: { count: 1 } }));
    expect(await controller.handle(request("state.emit", { payload: { count: 1 } }))).toEqual({
      ok: true,
      appended: false,
      coalesced: true,
    });
    nowMs += 5_000;
    await controller.handle(request("state.emit", { payload: { count: 1 } }));

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(1, "board.event", {
      ticket: "ticket",
      payload: { count: 1 },
    });
  });

  it("coalesces an identical state payload across interleaved emissions", async () => {
    const { controller, client } = setup({ now: () => 1_000 });

    await controller.handle(request("state.emit", { payload: { status: "first" } }));
    await controller.handle(request("state.emit", { payload: { status: "second" } }));
    expect(
      await controller.handle(request("state.emit", { payload: { status: "first" } })),
    ).toEqual({ ok: true, appended: false, coalesced: true });

    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("rejects state payloads above 8KB before the gateway call", async () => {
    const { controller, client } = setup();

    await expect(
      controller.handle(request("state.emit", { payload: "x".repeat(8_193) })),
    ).rejects.toThrow("exceeds 8192");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("allows a state payload to retry after delivery fails", async () => {
    const { controller, client } = setup();
    client.request.mockRejectedValueOnce(new Error("offline"));

    await expect(
      controller.handle(request("state.emit", { payload: { count: 1 } })),
    ).rejects.toThrow("offline");
    await expect(
      controller.handle(request("state.emit", { payload: { count: 1 } })),
    ).resolves.toEqual({ ok: true });

    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("rate-limits varying state payloads at the trusted host", async () => {
    let nowMs = 1_000;
    const { controller, client } = setup({ now: () => nowMs });

    for (let count = 0; count < 12; count += 1) {
      await controller.handle(request("state.emit", { payload: { count } }));
    }
    await expect(
      controller.handle(request("state.emit", { payload: { count: 12 } })),
    ).rejects.toThrow("rate limit exceeded");

    nowMs += 60_000;
    await expect(
      controller.handle(request("state.emit", { payload: { count: 13 } })),
    ).resolves.toEqual({ ok: true });

    expect(client.request).toHaveBeenCalledTimes(13);
  });

  it("maps read and cron requests to ticket-bound board RPCs", async () => {
    const { controller, client } = setup();

    await controller.handle(
      request("data.read", { bindingId: "health", params: { probe: false } }),
    );
    await controller.handle(request("cron.trigger", { jobId: "job-1" }));

    expect(client.request).toHaveBeenNthCalledWith(1, "board.data.read", {
      ticket: "ticket",
      bindingId: "health",
      params: { probe: false },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "board.action", {
      ticket: "ticket",
      action: "cron.trigger",
      jobId: "job-1",
    });
  });
});
