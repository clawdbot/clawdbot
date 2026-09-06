// @vitest-environment node

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayBrowserClientOptions } from "../api/gateway.ts";
import { clearStoredChatSnapshots } from "../pages/chat/session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

class SnapshotTestGatewayClient {
  constructor(readonly opts: GatewayBrowserClientOptions) {}
  start() {}
  stop() {}
}

describe("gateway credential snapshot invalidation", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("location", new URL("http://control.test/"));
  });

  afterEach(async () => {
    await clearStoredChatSnapshots();
    vi.unstubAllGlobals();
  });

  it("clears persisted transcripts on credential change but not an unchanged reconnect", async () => {
    const sessionKey = "agent:main:credential-scope";
    const snapshots = new SessionSnapshotStore();
    snapshots.write(sessionKey, {
      messages: ["private transcript"],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "credential-session",
    });
    await snapshots.flush();
    const settings = { ...loadSettings(), gatewayUrl: "ws://control.test", token: "old-token" };
    const gateway = createApplicationGateway(settings, "", "", (options) => {
      return new SnapshotTestGatewayClient(options) as unknown as GatewayBrowserClient;
    });

    gateway.connect();
    expect(await new SessionSnapshotStore().read(sessionKey)).not.toBeNull();

    gateway.connect({ token: "" });
    await vi.waitFor(async () => {
      expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
    });
  });
});
