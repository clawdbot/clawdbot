// Serialized into the standalone shell; keep runtime dependencies inside this function.
export function runStandaloneMcpAppHost(config: {
  protocolVersion: string;
  viewPath: string;
  initialLoadTimeoutMs: number;
}): void {
  type StandaloneElement = { className: string; textContent: string };
  type StandaloneFrame = StandaloneElement & {
    contentWindow?: { postMessage(message: unknown, targetOrigin: string): void };
    referrerPolicy: string;
    remove(): void;
    setAttribute(name: string, value: string): void;
    src: string;
    style: { height: string };
    title: string;
  };
  type StandaloneMessageEvent = { data: unknown; origin: string; source: unknown };
  // SAFETY: This serialized function runs in the browser shell, whose Window supplies these APIs.
  const browser = globalThis as unknown as {
    addEventListener(type: "message", listener: (event: StandaloneMessageEvent) => void): void;
    addEventListener(
      type: "pagehide" | "pageshow",
      listener: (event: { persisted: boolean }) => void,
    ): void;
    document: {
      createElement(name: "iframe"): StandaloneFrame;
      createElement(name: "p"): StandaloneElement;
      getElementById(id: string): { replaceChildren(...children: unknown[]): void } | null;
    };
    innerWidth: number;
    location: { hash: string; origin: string; reload(): void };
    matchMedia(query: string): { matches: boolean };
    navigator: { language: string };
  };
  type JsonRpcId = number | string;
  type JsonRpcMessage = {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
  };
  type ViewPayload = {
    sandboxUrl: string;
    sandboxPort: number;
    sandboxOrigin?: string;
    html: string;
    csp?: Record<string, unknown>;
    toolInput: unknown;
    toolResult: unknown;
    serverTools?: boolean;
    serverResources?: boolean;
  };

  const host = browser.document.getElementById("host");
  const ticket = browser.location.hash.startsWith("#") ? browser.location.hash.slice(1) : "";
  let frame: StandaloneFrame | undefined;
  let payload: ViewPayload | undefined;
  let initializeAccepted = false;
  let initialized = false;
  let requestId = 0;
  let sandboxOrigin: string | undefined;
  let teardownId: JsonRpcId | undefined;
  let phase: "active" | "tearing-down" | "suspended" | "closed" = "active";
  const pending = new Map<JsonRpcId, AbortController>();

  const asStandaloneRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>) // SAFETY: Guard excludes null/arrays; fields stay unknown.
      : undefined;
  const errorMessage = (error: unknown, timeoutMessage: string) =>
    asStandaloneRecord(error)?.name === "TimeoutError"
      ? timeoutMessage
      : error instanceof Error
        ? error.message
        : String(error);
  const fail = (message: string) => {
    if (phase === "suspended" || phase === "closed") {
      return;
    }
    removeFrame();
    host?.replaceChildren(
      Object.assign(browser.document.createElement("p"), {
        className: "error",
        textContent: message,
      }),
    );
  };
  const post = (message: JsonRpcMessage) => {
    if (sandboxOrigin) {
      frame?.contentWindow?.postMessage(message, sandboxOrigin);
    }
  };
  const notify = (method: string, params: unknown = {}) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const reject = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });
  const retireOperations = () => {
    for (const [id, controller] of pending) {
      pending.delete(id);
      controller.abort();
    }
  };
  const removeFrame = () => {
    phase = "closed";
    retireOperations();
    frame?.remove();
    frame = undefined;
    sandboxOrigin = undefined;
    teardownId = undefined;
  };
  const resolveSandboxUrl = (view: ViewPayload) => {
    const base = view.sandboxOrigin
      ? new URL(view.sandboxOrigin)
      : new URL(browser.location.origin);
    if (!view.sandboxOrigin) {
      base.port = String(view.sandboxPort);
    }
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    const resolved = new URL(view.sandboxUrl, base);
    if (
      !["http:", "https:"].includes(resolved.protocol) ||
      resolved.origin !== base.origin ||
      resolved.origin === browser.location.origin ||
      resolved.pathname !== "/mcp-app-sandbox"
    ) {
      throw new Error("MCP App sandbox URL is invalid");
    }
    return resolved;
  };
  const request = async (
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const response = await fetch(config.viewPath, {
      method: "POST",
      headers: {
        Authorization: `MCP-App ${ticket}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    // SAFETY: The paired Gateway owns this response envelope; its result remains unknown.
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; result?: unknown; error?: string }
      | undefined;
    // Body decoding may reject on cancellation; a retired response cannot close the live App.
    signal.throwIfAborted();
    if (response.status === 401) {
      fail("MCP App ticket was rejected");
      throw new Error("MCP App ticket was rejected");
    }
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || "MCP App operation was rejected");
    }
    return body.result;
  };
  const operations = new Set<string>();
  const installOperations = (view: ViewPayload) => {
    if (view.serverTools === true) {
      operations.add("tools/call");
      operations.add("tools/list");
    }
    if (view.serverResources === true) {
      operations.add("resources/list");
      operations.add("resources/templates/list");
      operations.add("resources/read");
    }
  };
  const deliverInitialState = () => {
    if (initialized || !payload) {
      return;
    }
    initialized = true;
    notify("ui/notifications/tool-input", {
      arguments: asStandaloneRecord(payload.toolInput) ?? {},
    });
    notify("ui/notifications/tool-result", payload.toolResult);
  };
  const isValidInitialize = (params: unknown) => {
    const record = asStandaloneRecord(params);
    const appInfo = asStandaloneRecord(record?.appInfo);
    return (
      typeof record?.protocolVersion === "string" &&
      typeof appInfo?.name === "string" &&
      typeof appInfo?.version === "string" &&
      asStandaloneRecord(record?.appCapabilities) !== undefined
    );
  };

  browser.addEventListener("message", (event) => {
    // SAFETY: Only inspect envelope fields before the source, origin, JSON-RPC and ID guards below.
    const message = asStandaloneRecord(event.data) as JsonRpcMessage | undefined;
    if (
      event.source !== frame?.contentWindow ||
      event.origin !== sandboxOrigin ||
      message?.jsonrpc !== "2.0" ||
      (message.id !== undefined &&
        typeof message.id !== "string" &&
        !(typeof message.id === "number" && Number.isInteger(message.id)))
    ) {
      return;
    }
    if (message.method === "notifications/cancelled") {
      const id = asStandaloneRecord(message.params)?.requestId;
      if (message.id === undefined && (typeof id === "string" || typeof id === "number")) {
        const controller = pending.get(id);
        pending.delete(id);
        controller?.abort();
      }
      return;
    }
    // MCP IDs are unique per requestor. A duplicate reply would settle the
    // original caller; opposite-direction teardown responses are not requests.
    if (typeof message.method === "string" && message.id !== undefined && pending.has(message.id)) {
      return;
    }
    if (message.method === "ui/notifications/sandbox-proxy-ready") {
      if (payload) {
        notify("ui/notifications/sandbox-resource-ready", {
          html: payload.html,
          csp: payload.csp,
        });
      }
      return;
    }
    if (message.method === "ping" && message.id !== undefined) {
      respond(message.id, {});
      return;
    }
    if (message.method === "ui/initialize" && message.id !== undefined) {
      if (!payload || !isValidInitialize(message.params)) {
        reject(message.id, -32602, "Invalid MCP App initialization");
        return;
      }
      initializeAccepted = true;
      respond(message.id, {
        protocolVersion: config.protocolVersion,
        hostInfo: { name: "OpenClaw standalone host", version: "1.0.0" },
        hostCapabilities: {
          sandbox: { csp: payload.csp ?? {} },
          ...(payload.serverTools === true ? { serverTools: {} } : {}),
          ...(payload.serverResources === true ? { serverResources: {} } : {}),
        },
        hostContext: {
          theme: browser.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: { width: Math.max(1, browser.innerWidth), height: 600 },
          locale: browser.navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          platform: "web",
        },
      });
      return;
    }
    if (message.method === "ui/notifications/initialized") {
      // A view cannot unlock server operations by skipping the validated handshake.
      if (!initializeAccepted) {
        return;
      }
      deliverInitialState();
      return;
    }
    if (message.method === "ui/notifications/size-changed") {
      const height = asStandaloneRecord(message.params)?.height;
      if (frame && typeof height === "number" && Number.isFinite(height)) {
        frame.style.height = `${Math.min(1200, Math.max(160, Math.round(height)))}px`;
      }
      return;
    }
    if (message.method === "ui/notifications/request-teardown") {
      if (phase !== "active") {
        return;
      }
      // App.onteardown may await existing work or save through another tool call.
      // Its acknowledgment or the bounded grace deadline closes request authority.
      phase = "tearing-down";
      const id = ++requestId;
      teardownId = id;
      post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      setTimeout(() => {
        if (teardownId === id) {
          removeFrame();
        }
      }, 1_000);
      return;
    }
    if (teardownId !== undefined && message.id === teardownId && message.method === undefined) {
      removeFrame();
      return;
    }
    if (
      phase === "suspended" ||
      phase === "closed" ||
      message.id === undefined ||
      typeof message.method !== "string"
    ) {
      return;
    }
    if (!operations.has(message.method)) {
      reject(message.id, -32601, `Method not available in standalone host: ${message.method}`);
      return;
    }
    if (!initialized) {
      reject(message.id, -32002, "MCP App initialization is incomplete");
      return;
    }
    const id = message.id;
    const controller = new AbortController();
    pending.set(id, controller);
    // The App owns its request lifetime, not a single upstream RPC's budget.
    // Retired completions must neither reply nor remove a newer map entry.
    void request(message.method, message.params ?? {}, controller.signal)
      .then((result) => {
        if (pending.get(id) === controller) {
          respond(id, result);
        }
      })
      .catch((error: unknown) => {
        if (pending.get(id) === controller) {
          reject(id, -32000, errorMessage(error, "MCP App operation timed out; try again"));
        }
      })
      .finally(() => {
        if (pending.get(id) === controller) {
          pending.delete(id);
        }
      });
  });
  browser.addEventListener("pagehide", (event) => {
    if (phase === "tearing-down") {
      phase = "closed";
    } else if (phase === "active") {
      phase = event.persisted ? "suspended" : "closed";
    }
    retireOperations();
    if (frame?.contentWindow) {
      post({ jsonrpc: "2.0", id: ++requestId, method: "ui/resource-teardown", params: {} });
    }
  });
  browser.addEventListener("pageshow", (event) => {
    if (event.persisted && phase === "suspended") {
      // Teardown may have disposed App state. Revalidate through a fresh document,
      // never revive the old heap or replay its interrupted operations.
      removeFrame();
      browser.location.reload();
    }
  });
  if (!ticket) {
    fail("MCP App ticket is missing");
    return;
  }
  void fetch(config.viewPath, {
    headers: { Authorization: `MCP-App ${ticket}` },
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(config.initialLoadTimeoutMs),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error("MCP App ticket was rejected");
      }
      // SAFETY: The ticket-scoped Gateway owns this payload; sandbox origin/path are checked below.
      const view = (await response.json()) as ViewPayload;
      if (phase !== "active") {
        return;
      }
      payload = view;
      installOperations(payload);
      const sandboxUrl = resolveSandboxUrl(payload);
      sandboxOrigin = sandboxUrl.origin;
      frame = browser.document.createElement("iframe");
      frame.title = "MCP App";
      frame.referrerPolicy = "origin";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      frame.src = sandboxUrl.href;
      host?.replaceChildren(frame);
    })
    .catch((error: unknown) =>
      fail(errorMessage(error, "MCP App view timed out; reload to try again")),
    );
}
