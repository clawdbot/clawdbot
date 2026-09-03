// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { startBrowserBootstrapRecovery } from "./browser-bootstrap.runtime.ts";
import {
  createGatewayStoreTestStore as createStore,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";

const OWNER_BOOTSTRAP = { bootstrapToken: "owner-bootstrap", bootstrapProfile: "owner" };
const PAGE_URL = "https://gateway.example/operator/chat/research?draft=hello#section";
let store: ReturnType<typeof createStore>;
let dispose: (() => void) | undefined;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function startRecovery(gatewayUrl = "wss://gateway.example/operator", basePath = "/operator") {
  store = createStore({ settings: { ...loadSettings(), gatewayUrl } });
  dispose = startBrowserBootstrapRecovery(store.gateway, basePath);
  store.gateway.start();
}

function rejectConnect(
  code: string = ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  willRetry = false,
) {
  store.current().opts.onClose?.({
    code: 4008,
    reason: "connect failed",
    error: { code: "INVALID_REQUEST", message: "auth failed", details: { code } },
    willRetry,
  });
}

async function settleFetch() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

beforeEach(() => {
  stubGatewayStoreTestGlobals();
  const location = new URL(PAGE_URL);
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", { location });
  fetchMock = vi.fn<typeof fetch>(async () => Response.json(OWNER_BOOTSTRAP));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  store?.gateway.stop();
  setAvatarGatewayOrigin(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("same-origin browser bootstrap recovery", () => {
  it("recovers a missing password for the exact mount without publishing credentials in the URL", async () => {
    startRecovery("wss://gateway.example/operator/");
    expect(fetchMock).not.toHaveBeenCalled();

    rejectConnect(ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING);
    await vi.waitFor(() => expect(store.clients).toHaveLength(2));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/operator/.well-known/openclaw/browser-bootstrap",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(store.current().opts).toMatchObject(OWNER_BOOTSTRAP);
    expect(store.gateway.connection.token).toBe("");
    expect(globalThis.location.href).toBe(PAGE_URL);
  });

  it.each([
    "wss://other.example/operator",
    "wss://gateway.example/different-mount",
    "ws://gateway.example/operator",
    "wss://user@gateway.example/operator",
    "wss://gateway.example/operator?target=another",
    "wss://gateway.example/operator#target",
  ])("does not mint credentials for the non-default endpoint %s", async (gatewayUrl) => {
    startRecovery(gatewayUrl);
    rejectConnect();
    await settleFetch();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.clients).toHaveLength(1);
  });

  it("does not request a handoff from a plain HTTP page", async () => {
    const location = new URL("http://gateway.example/operator/chat");
    vi.stubGlobal("location", location);
    vi.stubGlobal("window", { location });
    startRecovery("ws://gateway.example/operator");
    rejectConnect();
    await settleFetch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { token: "explicit-token" },
    { password: "explicit-password" },
    { bootstrapToken: "explicit-bootstrap" },
  ])("preserves explicit connection credentials %j", async (credentials) => {
    store = createStore({
      settings: { ...loadSettings(), gatewayUrl: "wss://gateway.example/operator" },
    });
    store.gateway.connect(credentials);
    dispose = startBrowserBootstrapRecovery(store.gateway, "/operator");
    rejectConnect();
    await settleFetch();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.gateway.connection).toMatchObject(credentials);
  });

  it.each([
    ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
    ConnectErrorDetailCodes.PAIRING_REQUIRED,
    ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH,
  ])("does not replace a credential after %s", async (errorCode) => {
    startRecovery();
    rejectConnect(errorCode);
    await settleFetch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for the actual terminal auth failure before considering a handoff", async () => {
    startRecovery();
    rejectConnect(ConnectErrorDetailCodes.AUTH_TOKEN_MISSING, true);
    await settleFetch();
    expect(fetchMock).not.toHaveBeenCalled();

    rejectConnect();
    await vi.waitFor(() => expect(store.clients).toHaveLength(2));
  });

  it.each([
    { name: "missing endpoint", response: () => new Response(null, { status: 404 }) },
    { name: "denied identity", response: () => new Response(null, { status: 403 }) },
    {
      name: "invalid JSON",
      response: () => new Response("not-json", { headers: { "Content-Type": "application/json" } }),
    },
    {
      name: "extra fields",
      response: () => Response.json({ ...OWNER_BOOTSTRAP, token: "shared" }),
    },
    {
      name: "wrong profile",
      response: () => Response.json({ ...OWNER_BOOTSTRAP, bootstrapProfile: "node" }),
    },
    {
      name: "empty credential",
      response: () => Response.json({ ...OWNER_BOOTSTRAP, bootstrapToken: "" }),
    },
    {
      name: "whitespace credential",
      response: () => Response.json({ ...OWNER_BOOTSTRAP, bootstrapToken: "two words" }),
    },
    {
      name: "control character",
      response: () => Response.json({ ...OWNER_BOOTSTRAP, bootstrapToken: "bad\u0001token" }),
    },
    {
      name: "oversized credential",
      response: () => Response.json({ ...OWNER_BOOTSTRAP, bootstrapToken: "a".repeat(4097) }),
    },
  ])("leaves failed login actionable without a retry loop on $name", async ({ response }) => {
    fetchMock.mockImplementation(async () => response());
    startRecovery();
    rejectConnect();
    await settleFetch();
    rejectConnect();
    await settleFetch();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.clients).toHaveLength(1);
    expect(store.gateway.snapshot.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISSING);
    expect(store.gateway.connection.bootstrapToken).toBe("");
  });

  it("cancels a streamed response once the envelope exceeds its byte bound", async () => {
    const cancel = vi.fn();
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(" ".repeat(8193)));
            },
            cancel,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    startRecovery();
    rejectConnect();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(store.clients).toHaveLength(1);
  });

  it.each(["manual retry", "changed credentials", "stopped gateway", "disposed recovery"])(
    "discards an awaited handoff after %s",
    async (action) => {
      let deliver!: (response: Response) => void;
      fetchMock.mockReturnValue(
        new Promise((resolve) => {
          deliver = resolve;
        }),
      );
      startRecovery();
      rejectConnect();
      expect(fetchMock).toHaveBeenCalledOnce();
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;

      if (action === "manual retry") {
        store.gateway.connect();
      } else if (action === "changed credentials") {
        store.gateway.connect({ token: "user-token" });
      } else if (action === "stopped gateway") {
        store.gateway.stop();
      } else {
        dispose?.();
      }
      const clientCount = store.clients.length;
      deliver(Response.json(OWNER_BOOTSTRAP));
      await settleFetch();

      expect(signal?.aborted).toBe(true);
      expect(store.clients).toHaveLength(clientCount);
      expect(store.gateway.connection.bootstrapToken).toBe("");
      if (action === "changed credentials") {
        expect(store.gateway.connection.token).toBe("user-token");
      }
    },
  );

  it("bounds a stalled handoff without retrying or hiding the auth error", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    startRecovery();
    rejectConnect();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    await vi.advanceTimersByTimeAsync(45_000);

    expect(signal?.aborted).toBe(true);
    expect(store.clients).toHaveLength(1);
    expect(store.gateway.snapshot.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISSING);
    rejectConnect();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
