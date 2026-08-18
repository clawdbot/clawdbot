import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

function installPendingIndexedDbOpen() {
  const request = new EventTarget() as IDBOpenDBRequest;
  Object.defineProperty(request, "error", {
    value: new DOMException("storage unavailable", "UnknownError"),
  });
  const open = vi.fn(() => request);
  vi.stubGlobal("indexedDB", { open });
  return { open, request };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("schedules confirmed draft retirement without delaying session deletion", async () => {
  const key = "agent:main:confirmed-delete";
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.delete") {
      return { ok: true, deleted: true };
    }
    if (method === "sessions.list") {
      return sessionsResult([], 2);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = {
    gatewayUrl: "ws://gateway.test",
    recoveryScope: "credential-a",
    recoveryScopeReady: true,
    request,
  } as unknown as GatewayBrowserClient;
  const { open, request: openRequest } = installPendingIndexedDbOpen();
  const { gateway } = createGatewayHarness(client);
  const sessions = createSessionCapability(gateway);

  await expect(sessions.delete(key)).resolves.toEqual({ deleted: true });
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());

  // Let the intentionally pending best-effort cleanup settle without leaking
  // IndexedDB module state into the shared isolate:false UI test worker.
  openRequest.dispatchEvent(new Event("error"));
  await Promise.resolve();
  sessions.dispose();
});

it("does not schedule draft retirement for a deletion no-op", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.delete") {
      return { ok: true, deleted: false };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = {
    gatewayUrl: "ws://gateway.test",
    recoveryScope: "credential-a",
    recoveryScopeReady: true,
    request,
  } as unknown as GatewayBrowserClient;
  const { open } = installPendingIndexedDbOpen();
  const { gateway } = createGatewayHarness(client);
  const sessions = createSessionCapability(gateway);

  await expect(sessions.delete("agent:main:not-deleted")).resolves.toEqual({ deleted: false });
  expect(open).not.toHaveBeenCalled();
  sessions.dispose();
});
