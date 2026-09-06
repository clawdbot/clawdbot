import { afterEach, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

export const CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS = 800;

function configGatewayHello(): GatewayHelloOk {
  return gatewayHelloForMethods(["config.schema", "config.set", "config.apply", "config.patch"]);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot: {
    client: GatewayBrowserClient;
    phase: ApplicationGatewayPhase;
    sessionKey: string;
    hello?: GatewayHelloOk | null;
  } = { client, phase: "connected", sessionKey: "main", hello: configGatewayHello() };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish: (
      connected: boolean,
      nextClient: GatewayBrowserClient = client,
      hello?: GatewayHelloOk | null,
    ) => {
      snapshot = {
        client: nextClient,
        phase: connected ? "connected" : "reconnecting",
        sessionKey: "main",
        hello: hello === undefined ? configGatewayHello() : hello,
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Simple hash-tracking config.get/config.set/config.apply mock gateway. */
export function createConfigServerMock() {
  let hashCounter = 1;
  let appliedHash = "hash-1";
  let storedRaw = '{\n  "count": 1\n}\n';
  const submissions: Array<{ method: string; raw: string; baseHash: string }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config: JSON.parse(storedRaw) as Record<string, unknown>,
        raw: storedRaw,
        hash: `hash-${hashCounter}`,
        configRevisionHash: `hash-${hashCounter}`,
        appliedConfigHash: appliedHash,
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set" || method === "config.apply") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      submissions.push({ method, raw, baseHash });
      storedRaw = raw;
      hashCounter += 1;
      if (method === "config.apply") {
        appliedHash = `hash-${hashCounter}`;
      }
      // Like the real gateway: ack with the persisted snapshot hash.
      return { hash: `hash-${hashCounter}` };
    }
    return {};
  });
  return { request, submissions, currentHash: () => `hash-${hashCounter}` };
}

/**
 * createConfigServerMock variant whose FIRST config.set stays pending until
 * `firstSet` resolves — for exercising mid-flight edits/reverts/teardown.
 */
export function createDeferredSetServerMock() {
  const firstSet = deferred<unknown>();
  let hashCounter = 1;
  let storedRaw = '{\n  "count": 1\n}\n';
  const submissions: Array<{ raw: string; baseHash: string }> = [];
  const applySubmissions: Array<{ raw: string; baseHash: string }> = [];
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "config.get") {
      return Promise.resolve({
        config: JSON.parse(storedRaw) as Record<string, unknown>,
        raw: storedRaw,
        hash: `hash-${hashCounter}`,
        valid: true,
        issues: [],
      });
    }
    if (method === "config.set") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      submissions.push({ raw, baseHash });
      storedRaw = raw;
      hashCounter += 1;
      const ack = { hash: `hash-${hashCounter}` };
      return submissions.length === 1 ? firstSet.promise.then(() => ack) : Promise.resolve(ack);
    }
    if (method === "config.apply") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      applySubmissions.push({ raw, baseHash });
      storedRaw = raw;
      hashCounter += 1;
      return Promise.resolve({ hash: `hash-${hashCounter}` });
    }
    return Promise.resolve({});
  });
  return { request, submissions, applySubmissions, firstSet };
}

export function createConfigCapabilityHarness(request: GatewayBrowserClient["request"]) {
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway, publish } = createGatewayHarness(client);
  return { runtimeConfig: createRuntimeConfigCapability(gateway), publish };
}
