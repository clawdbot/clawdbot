/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { createApplicationUpdateOverlays } from "./overlays-updates.ts";
import { loadSettings } from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";
import "./app-host.ts";

vi.hoisted(() => {
  vi.stubGlobal("OPENCLAW_CONTROL_UI_BUILD_INFO", {
    version: "1.0.0",
    buildId: "serving-build",
    commit: null,
    commitAt: null,
    builtAt: null,
    branch: null,
    dirty: null,
    release: false,
  });
});

type RefreshShell = HTMLElement & {
  runtime: ApplicationRuntime;
  refreshControlUi: () => Promise<boolean>;
};

function createRefreshShell(gateway: ApplicationRuntime["context"]["gateway"]) {
  const snapshot = { controlUiRefreshRequired: true };
  const shell = document.createElement("openclaw-app-shell") as RefreshShell;
  shell.runtime = {
    context: { overlays: { snapshot }, gateway },
  } as unknown as ApplicationRuntime;
  return { shell, snapshot };
}

describe("OpenClaw shell Control UI refresh", () => {
  let store: ReturnType<typeof createGatewayStoreTestStore>;
  let probe: ReturnType<typeof createDeferred<Response>>;
  let replace: ReturnType<typeof vi.fn<(url: string) => void>>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    stubGatewayStoreTestGlobals();
    replace = vi.fn();
    const location = Object.assign(new URL("http://127.0.0.1:18789/chat/main"), { replace });
    vi.stubGlobal("location", location);
    vi.stubGlobal("window", { location });
    probe = createDeferred<Response>();
    fetchMock = vi.fn<typeof fetch>(() => probe.promise);
    vi.stubGlobal("fetch", fetchMock);
    store = createGatewayStoreTestStore();
    store.gateway.connect({
      bootstrapToken: "synthetic-owner-bootstrap",
      bootstrapProfile: "owner",
    });
  });

  afterEach(() => {
    store.gateway.stop();
    setAvatarGatewayOrigin(null);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["clear", "replace"])(
    "does not reload after the shell recovery state changes: %s",
    async (action) => {
      const { shell, snapshot } = createRefreshShell(store.gateway);
      const refresh = shell.refreshControlUi();
      if (action === "clear") {
        snapshot.controlUiRefreshRequired = false;
      } else {
        shell.runtime = createRefreshShell(store.gateway).shell.runtime;
      }
      probe.resolve(new Response(null, { status: 200 }));

      await expect(refresh).resolves.toBe(false);
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it("continues the browser handoff when manual refresh follows a failed automatic probe", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    store.current().opts.onClose?.({
      code: 1008,
      reason: "Control UI updated",
      error: {
        code: "UNAVAILABLE",
        message: "Control UI updated",
        details: {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
      },
      willRetry: false,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(replace).not.toHaveBeenCalled();
    const { shell } = createRefreshShell(store.gateway);

    const refresh = shell.refreshControlUi();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    probe.resolve(new Response(null, { status: 200 }));

    await expect(refresh).resolves.toBe(true);
    expect(replace).toHaveBeenCalledOnce();
    const resumed = resolveApplicationStartupSettings(
      loadSettings(),
      new URL(replace.mock.calls[0]![0]),
    );
    expect(resumed.pendingBootstrapToken).toBe("synthetic-owner-bootstrap");
    expect(resumed.pendingBootstrapProfile).toBe("owner");
    expect(resumed.location.hash).toBe("");
  });

  it.each(["browser", "native"] as const)(
    "preserves the producer-offered cross-origin manual Refresh for %s",
    async (surface) => {
      store.gateway.stop();
      store = createGatewayStoreTestStore({
        clientOptions:
          surface === "native" ? { clientName: "openclaw-ios", mode: "ui" } : undefined,
      });
      const updates = createApplicationUpdateOverlays(store.gateway, vi.fn());
      const unsubscribe = store.gateway.subscribe(updates.synchronizeGateway);
      try {
        store.gateway.connect({ gatewayUrl: "wss://remote-gateway.example" });
        store.current().opts.onHello?.({
          type: "hello-ok",
          protocol: 1,
          auth: { role: "operator", scopes: ["operator.read"] },
          server: { version: "1.0.0", buildId: "remote-build", connId: "remote-connection" },
        });
        expect(store.gateway.snapshot.phase).toBe("connected");
        expect(store.gateway.connection.bootstrapToken).toBe("");
        expect(updates.snapshot.controlUiRefreshRequired).toBe(true);
        const { shell } = createRefreshShell(store.gateway);
        shell.runtime = {
          context: { gateway: store.gateway, overlays: updates },
        } as unknown as ApplicationRuntime;
        const refresh = shell.refreshControlUi();
        probe.resolve(new Response(null, { status: 200 }));

        await expect(refresh).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(replace).toHaveBeenCalledOnce();
        const destination = new URL(replace.mock.calls[0]![0]);
        expect(destination.origin).toBe("http://127.0.0.1:18789");
        expect(destination.hash).toBe("");
      } finally {
        unsubscribe();
        updates.dispose();
      }
    },
  );

  it("keeps a pending remote handoff out of the serving document on manual Refresh", async () => {
    store.gateway.connect({
      gatewayUrl: "wss://remote-gateway.example",
      bootstrapToken: "synthetic-remote-bootstrap",
    });
    const { shell } = createRefreshShell(store.gateway);
    const refresh = shell.refreshControlUi();
    probe.resolve(new Response(null, { status: 200 }));

    await expect(refresh).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
