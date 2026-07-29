import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardWidget } from "./types.ts";
import { BoardWidgetSandboxHost } from "./widget-sandbox-host.ts";

const SANDBOX_URL = "https://sandbox.example/mcp-app-sandbox";

function widget(): BoardWidget {
  return {
    name: "weather",
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "granted",
    revision: 2,
    viewTicket: "ticket",
    viewGeneration: "a".repeat(32),
  };
}

async function offerBridgePort(
  host: BoardWidgetSandboxHost,
  frame: HTMLIFrameElement,
  onHostMessage?: (event: MessageEvent) => void,
): Promise<MessagePort> {
  const channel = new MessageChannel();
  let initialTicketAdopted = false;
  const initialized = new Promise<void>((resolve) => {
    channel.port2.addEventListener("message", (event) => {
      onHostMessage?.(event);
      if (
        !initialTicketAdopted &&
        event.data?.type === "openclaw:widget-host-init" &&
        typeof event.data.ticket === "string"
      ) {
        initialTicketAdopted = true;
        channel.port2.postMessage(
          {
            type: "openclaw:widget-host-init-ack",
            ticket: event.data.ticket,
          },
          [],
        );
        resolve();
      }
    });
  });
  channel.port2.start();
  host.handleMessage(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "https://sandbox.example",
      data: { type: "openclaw:widget-bridge-port-offer" },
      ports: [channel.port1],
    }),
  );
  await initialized;
  return channel.port2;
}

async function sendBridgeRequest(port: MessagePort, request: Record<string, unknown>) {
  return await new Promise<Record<string, unknown>>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "openclaw:widget-bridge-response" || event.data.id !== request.id) {
        return;
      }
      port.removeEventListener("message", listener);
      resolve(event.data as Record<string, unknown>);
    };
    port.addEventListener("message", listener);
    port.postMessage(request, []);
  });
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("BoardWidgetSandboxHost", () => {
  it("loads ticketed HTML only after the dedicated proxy is ready", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const fetchMock = vi.fn(async () => new Response("<!doctype html><p>weather</p>"));
    vi.stubGlobal("fetch", fetchMock);
    const onLoaded = vi.fn();
    const host = new BoardWidgetSandboxHost({
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      client: { request: vi.fn(async () => ({ ok: true })) },
      resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded,
      onError: vi.fn(),
    });

    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );

    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/__openclaw__/board/weather?bt=ticket",
      { cache: "no-store" },
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "<!doctype html><p>weather</p>" },
      }),
      "https://sandbox.example",
    );
  });

  it("routes transient document fetch failures through the refresh budget", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const onLoadFailed = vi.fn();
    const onError = vi.fn();
    const host = new BoardWidgetSandboxHost({
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      client: { request: vi.fn(async () => ({ ok: true })) },
      resolveFrameUrl: () => "/__openclaw__/board/weather?bt=ticket",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed,
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded: vi.fn(),
      onError,
    });

    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );

    await vi.waitFor(() => expect(onLoadFailed).toHaveBeenCalledWith(widget()));
    expect(onError).not.toHaveBeenCalled();
  });

  it("injects the active view ticket only after the current document is loaded", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><p>weather</p>")),
    );
    const onLoaded = vi.fn();
    const host = new BoardWidgetSandboxHost({
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      resolveFrameUrl: () => "/widget",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded,
      onError: vi.fn(),
    });

    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
    const hostMessage = vi.fn();
    await offerBridgePort(host, frame, hostMessage);

    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: { type: "openclaw:widget-bridge-ready" },
      }),
    );

    expect(hostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { type: "openclaw:widget-host-init", ticket: "ticket" },
      }),
    );
  });

  it("drops a bridge response after the widget document is replaced", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><p>weather</p>")),
    );
    let resolveRequest: (value: unknown) => void = () => {};
    const client = {
      request: vi.fn(
        async () =>
          await new Promise<unknown>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    };
    const baseOptions = {
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      client,
      resolveFrameUrl: () => "/widget",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded: vi.fn(),
      onError: vi.fn(),
    };
    const host = new BoardWidgetSandboxHost(baseOptions);
    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );
    await vi.waitFor(() => expect(baseOptions.onLoaded).toHaveBeenCalledOnce());
    const bridgePort = await offerBridgePort(host, frame);
    const bridgeResponse = vi.fn();
    bridgePort.addEventListener("message", bridgeResponse);
    postMessage.mockClear();

    bridgePort.postMessage(
      {
        type: "openclaw:widget-bridge-request",
        id: "old-request",
        method: "data.read",
        params: { bindingId: "health" },
        ticket: "ticket",
      },
      [],
    );
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    host.update({
      ...baseOptions,
      widget: { ...widget(), revision: 3, viewTicket: "next-ticket" },
    });
    resolveRequest({ sensitive: "old grant result" });
    await Promise.resolve();
    await Promise.resolve();

    expect(bridgeResponse).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith(
      { type: "openclaw:widget-host-init", ticket: "next-ticket" },
      "https://sandbox.example",
    );
  });

  it("accepts bridge requests only on the wrapper-owned private port", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><button>prompt</button>")),
    );
    const client = {
      request: vi.fn(async (method: string) =>
        method === "board.prompt.authorize" ? { confirmationRequired: false } : { ok: true },
      ),
    };
    const host = new BoardWidgetSandboxHost({
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      client,
      resolveFrameUrl: () => "/widget",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded: vi.fn(),
      onError: vi.fn(),
    });
    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const promptRequest = {
      type: "openclaw:widget-bridge-request",
      id: "prompt-request",
      method: "prompt.send",
      params: { text: "Injected" },
      ticket: "ticket",
    };

    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: promptRequest,
      }),
    );
    await Promise.resolve();
    expect(client.request).not.toHaveBeenCalled();

    const bridgePort = await offerBridgePort(host, frame);
    bridgePort.postMessage(promptRequest, []);
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith("board.prompt.authorize", {
        ticket: "ticket",
      }),
    );
  });

  it("scopes prompt rate limits to the board source and view generation", async () => {
    const sessionPrefix = `session-${crypto.randomUUID()}`;
    let activeFrame: HTMLIFrameElement | null = null;
    Object.defineProperty(document, "activeElement", {
      get: () => activeFrame,
      configurable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><button>prompt</button>")),
    );
    const setup = async (sessionId: string, viewGeneration: string) => {
      const frame = document.createElement("iframe");
      frame.checkVisibility = () => true;
      document.body.append(frame);
      const loaded = vi.fn();
      const host = new BoardWidgetSandboxHost({
        frame,
        widget: { ...widget(), viewGeneration },
        sandboxOrigin: "https://sandbox.example",
        sandboxUrl: SANDBOX_URL,
        sourceOrigin: "https://gateway.example",
        client: {
          request: vi.fn(async (method: string) =>
            method === "board.prompt.authorize" ? { confirmationRequired: false } : { ok: true },
          ),
        },
        resolveFrameUrl: () => `/__openclaw__/board/${sessionId}/weather/index.html?bt=ticket`,
        confirmPrompt: () => true,
        onFrameUrl: vi.fn(),
        onLoadFailed: vi.fn(),
        onUnauthorized: vi.fn(),
        onReadyTimeout: vi.fn(),
        onLoaded: loaded,
        onError: vi.fn(),
      });
      host.handleMessage(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "https://sandbox.example",
          data: {
            method: "ui/notifications/sandbox-proxy-ready",
            params: { sandboxUrl: SANDBOX_URL },
          },
        }),
      );
      await vi.waitFor(() => expect(loaded).toHaveBeenCalledOnce());
      return { frame, port: await offerBridgePort(host, frame) };
    };
    const first = await setup(`${sessionPrefix}-a`, "a".repeat(32));
    activeFrame = first.frame;
    for (let index = 0; index < 10; index += 1) {
      await expect(
        sendBridgeRequest(first.port, {
          type: "openclaw:widget-bridge-request",
          id: `first-${index}`,
          method: "prompt.send",
          params: { text: `Prompt ${index}` },
          ticket: "ticket",
        }),
      ).resolves.toMatchObject({ ok: true });
    }

    const otherSession = await setup(`${sessionPrefix}-b`, "a".repeat(32));
    activeFrame = otherSession.frame;
    await expect(
      sendBridgeRequest(otherSession.port, {
        type: "openclaw:widget-bridge-request",
        id: "other-session",
        method: "prompt.send",
        params: { text: "Independent session" },
        ticket: "ticket",
      }),
    ).resolves.toMatchObject({ ok: true });

    const recreated = await setup(`${sessionPrefix}-a`, "b".repeat(32));
    activeFrame = recreated.frame;
    await expect(
      sendBridgeRequest(recreated.port, {
        type: "openclaw:widget-bridge-request",
        id: "recreated-view",
        method: "prompt.send",
        params: { text: "Independent generation" },
        ticket: "ticket",
      }),
    ).resolves.toMatchObject({ ok: true });
    delete (document as unknown as Record<string, unknown>).activeElement;
  });

  it("keeps the adopted ticket valid until the wrapper acknowledges a renewal", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><p>weather</p>")),
    );
    let resolveRead: (value: unknown) => void = () => {};
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "board.data.read") {
          return await new Promise<unknown>((resolve) => {
            resolveRead = resolve;
          });
        }
        return { ok: true };
      }),
    };
    const baseOptions = {
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      client,
      resolveFrameUrl: () => "/widget?bt=ticket",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded: vi.fn(),
      onError: vi.fn(),
    };
    const host = new BoardWidgetSandboxHost(baseOptions);
    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );
    await vi.waitFor(() => expect(baseOptions.onLoaded).toHaveBeenCalledOnce());
    const bridgePort = await offerBridgePort(host, frame);
    const responses: unknown[] = [];
    let renewalTicket = "";
    bridgePort.addEventListener("message", (event) => {
      if (event.data?.type === "openclaw:widget-host-init") {
        renewalTicket = event.data.ticket;
      } else if (event.data?.type === "openclaw:widget-bridge-response") {
        responses.push(event.data);
      }
    });

    bridgePort.postMessage(
      {
        type: "openclaw:widget-bridge-request",
        id: "in-flight",
        method: "data.read",
        params: { bindingId: "health" },
        ticket: "ticket",
      },
      [],
    );
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    host.update({
      ...baseOptions,
      widget: { ...widget(), viewTicket: "renewed-ticket" },
      resolveFrameUrl: () => "/widget?bt=renewed-ticket",
    });
    bridgePort.postMessage(
      {
        type: "openclaw:widget-bridge-request",
        id: "before-ack",
        method: "state.emit",
        params: { payload: { phase: "renewing" } },
        ticket: "ticket",
      },
      [],
    );
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(renewalTicket).toBe("renewed-ticket"));

    bridgePort.postMessage(
      {
        type: "openclaw:widget-host-init-ack",
        ticket: renewalTicket,
      },
      [],
    );
    resolveRead({ status: "healthy" });
    await vi.waitFor(() =>
      expect(responses).toContainEqual(expect.objectContaining({ id: "in-flight", ok: true })),
    );
    bridgePort.postMessage(
      {
        type: "openclaw:widget-bridge-request",
        id: "after-ack",
        method: "state.emit",
        params: { payload: { phase: "renewed" } },
        ticket: "renewed-ticket",
      },
      [],
    );
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(3));
    expect(client.request).toHaveBeenNthCalledWith(2, "board.event", {
      ticket: "ticket",
      payload: { phase: "renewing" },
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "board.event", {
      ticket: "renewed-ticket",
      payload: { phase: "renewed" },
    });
  });

  it("cancels in-flight requests when the Gateway client is replaced", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><p>weather</p>")),
    );
    let resolveOldRequest: (value: unknown) => void = () => {};
    const oldClient = {
      request: vi.fn(
        async () =>
          await new Promise<unknown>((resolve) => {
            resolveOldRequest = resolve;
          }),
      ),
    };
    const newClient = { request: vi.fn(async () => ({ ok: true })) };
    const baseOptions = {
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      client: oldClient,
      resolveFrameUrl: () => "/widget?bt=ticket",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded: vi.fn(),
      onError: vi.fn(),
    };
    const host = new BoardWidgetSandboxHost(baseOptions);
    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );
    await vi.waitFor(() => expect(baseOptions.onLoaded).toHaveBeenCalledOnce());
    const bridgePort = await offerBridgePort(host, frame);
    const responses: unknown[] = [];
    bridgePort.addEventListener("message", (event) => {
      if (event.data?.type === "openclaw:widget-bridge-response") {
        responses.push(event.data);
      }
    });

    bridgePort.postMessage(
      {
        type: "openclaw:widget-bridge-request",
        id: "old-client",
        method: "data.read",
        params: { bindingId: "health" },
        ticket: "ticket",
      },
      [],
    );
    await vi.waitFor(() => expect(oldClient.request).toHaveBeenCalledOnce());
    host.update({ ...baseOptions, client: newClient });
    await vi.waitFor(() =>
      expect(responses).toContainEqual({
        type: "openclaw:widget-bridge-response",
        id: "old-client",
        ok: false,
        error: "Gateway connection changed",
      }),
    );
    resolveOldRequest({ private: "old-context" });
    await Promise.resolve();
    await Promise.resolve();
    expect(responses).not.toContainEqual(expect.objectContaining({ id: "old-client", ok: true }));

    await expect(
      sendBridgeRequest(bridgePort, {
        type: "openclaw:widget-bridge-request",
        id: "new-client",
        method: "state.emit",
        params: { payload: { phase: "reconnected" } },
        ticket: "ticket",
      }),
    ).resolves.toMatchObject({ id: "new-client", ok: true });
    expect(newClient.request).toHaveBeenCalledWith("board.event", {
      ticket: "ticket",
      payload: { phase: "reconnected" },
    });
  });

  it("reloads equal-name revisions when their board session identity changes", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const fetchMock = vi.fn(async () => new Response("<!doctype html><p>session</p>"));
    vi.stubGlobal("fetch", fetchMock);
    const onLoaded = vi.fn();
    const baseOptions = {
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      client: { request: vi.fn(async () => ({ ok: true })) },
      resolveFrameUrl: () => "/__openclaw__/board/session-a/weather/index.html?bt=one",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded,
      onError: vi.fn(),
    };
    const host = new BoardWidgetSandboxHost(baseOptions);
    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
    postMessage.mockClear();

    host.update({
      ...baseOptions,
      widget: { ...widget(), viewTicket: "next-ticket" },
      resolveFrameUrl: () => "/__openclaw__/board/session-b/weather/index.html?bt=two",
    });

    expect(postMessage).not.toHaveBeenCalledWith(
      { type: "openclaw:widget-host-init", ticket: "next-ticket" },
      "https://sandbox.example",
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("waits for the exact sandbox CSP navigation before delivering replacement HTML", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const wideSandboxUrl = `${SANDBOX_URL}?csp=wide`;
    const narrowSandboxUrl = `${SANDBOX_URL}?csp=narrow`;
    const fetchMock = vi.fn(async () => new Response("<!doctype html><p>policy</p>"));
    vi.stubGlobal("fetch", fetchMock);
    const baseOptions = {
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: wideSandboxUrl,
      sourceOrigin: "https://gateway.example",
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=ticket",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded: vi.fn(),
      onError: vi.fn(),
    };
    const host = new BoardWidgetSandboxHost(baseOptions);
    const ready = (sandboxUrl: string) =>
      host.handleMessage(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "https://sandbox.example",
          data: {
            method: "ui/notifications/sandbox-proxy-ready",
            params: { sandboxUrl },
          },
        }),
      );

    ready(wideSandboxUrl);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    host.update({
      ...baseOptions,
      sandboxUrl: narrowSandboxUrl,
      widget: {
        ...widget(),
        revision: 3,
        viewTicket: "replacement-ticket",
        viewGeneration: "b".repeat(32),
      },
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=replacement-ticket",
    });

    ready(wideSandboxUrl);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    ready(narrowSandboxUrl);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("reloads a deleted and recreated widget without reloading routine ticket renewals", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const fetchMock = vi.fn(async () => new Response("<!doctype html><p>generation</p>"));
    vi.stubGlobal("fetch", fetchMock);
    const onLoaded = vi.fn();
    const baseOptions = {
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=ticket",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout: vi.fn(),
      onLoaded,
      onError: vi.fn(),
    };
    const host = new BoardWidgetSandboxHost(baseOptions);
    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: {
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: SANDBOX_URL },
        },
      }),
    );
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());

    host.update({
      ...baseOptions,
      widget: { ...widget(), viewTicket: "renewed-ticket" },
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=renewed-ticket",
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    host.update({
      ...baseOptions,
      widget: {
        ...widget(),
        viewTicket: "replacement-ticket",
        viewGeneration: "b".repeat(32),
      },
      resolveFrameUrl: () => "/__openclaw__/board/session/weather/index.html?bt=replacement-ticket",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("bounds missing proxy readiness and stops the timer on disposal", async () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const onReadyTimeout = vi.fn();
    const host = new BoardWidgetSandboxHost({
      frame,
      widget: widget(),
      sandboxOrigin: "https://sandbox.example",
      sandboxUrl: SANDBOX_URL,
      sourceOrigin: "https://gateway.example",
      resolveFrameUrl: () => "/widget",
      confirmPrompt: () => true,
      onFrameUrl: vi.fn(),
      onLoadFailed: vi.fn(),
      onUnauthorized: vi.fn(),
      onReadyTimeout,
      onLoaded: vi.fn(),
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onReadyTimeout).toHaveBeenCalledOnce();
    expect(frame.src).toBe(SANDBOX_URL);
    const reloadSpy = vi.spyOn(frame, "src", "set");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reloadSpy).toHaveBeenCalledWith(SANDBOX_URL);
    expect(onReadyTimeout).toHaveBeenCalledTimes(2);
    host.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onReadyTimeout).toHaveBeenCalledTimes(2);
  });
});
