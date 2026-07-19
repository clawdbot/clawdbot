/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createStorageMock as createTestStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  addDismissal,
  dismissalStoreKey,
  pruneDismissals,
  type SidebarAttentionKind,
} from "./sidebar-attention-dismissals.ts";
import { buildSidebarAttentionItems } from "./sidebar-attention-items.ts";
import "./sidebar-attention.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cronJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    state: { lastRunStatus: "error" },
  };
}

type SidebarAttentionElement = HTMLElement & {
  updateComplete: Promise<boolean>;
  cronJobs: CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
  loadedAtMs: number;
};

function approval(id: string): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: "echo ok" },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function approvalItems(queue: readonly ExecApprovalRequest[]) {
  return buildSidebarAttentionItems({
    cronJobs: [],
    modelAuthStatus: null,
    approvalQueue: queue,
    now: 0,
  }).filter((item) => item.kind === "pendingApproval");
}

describe("pending approval attention", () => {
  it("builds a warning chip only while approvals are pending", () => {
    expect(approvalItems([])).toEqual([]);

    expect(approvalItems([approval("exec:b")])).toMatchObject([
      {
        kind: "pendingApproval",
        severity: "warning",
        icon: "shieldCheck",
        action: { kind: "openApprovals" },
      },
    ]);
  });

  it("sorts queue ids into a signature that changes for a new approval", () => {
    const first = approvalItems([approval("exec:b"), approval("exec:a")])[0];
    const changed = approvalItems([approval("exec:b"), approval("exec:a"), approval("exec:c")])[0];

    if (!first || !changed) {
      throw new Error("expected pending approval attention items");
    }

    expect(first.signature).toBe("exec:a\nexec:b");
    expect(changed.signature).toBe("exec:a\nexec:b\nexec:c");
    expect(pruneDismissals({ pendingApproval: first.signature }, [changed])).toEqual({});
  });
});

describe("sidebar attention refresh ownership", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the latest refresh when an older load on the same client finishes last", async () => {
    const firstCron = deferred<unknown>();
    const firstAuth = deferred<unknown>();
    const secondCron = deferred<unknown>();
    const secondAuth = deferred<unknown>();
    const responses = {
      "cron.list": [firstCron, secondCron],
      "models.authStatus": [firstAuth, secondAuth],
    };
    const request = vi.fn((method: keyof typeof responses) => {
      const response = responses[method].shift();
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return response.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: true,
      reconnecting: false,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    };
    const gateway = {
      snapshot,
      connection: {
        gatewayUrl: "ws://gateway.test",
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe: () => () => undefined,
    } as unknown as ApplicationGateway;
    const overlays = {
      snapshot: { approvalQueue: [] },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["overlays"];
    const storage = createTestStorageMock();
    vi.stubGlobal("localStorage", storage);
    localStorage.setItem(
      dismissalStoreKey(gateway.connection.gatewayUrl),
      JSON.stringify({ cronFailed: "current" }),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const provider = createApplicationContextProvider({ gateway, overlays } as ApplicationContext);
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    provider.append(element);
    document.body.append(provider);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    document.dispatchEvent(new Event("visibilitychange"));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));

    const currentAuth = { ts: 2, providers: [] } as ModelAuthStatusResult;
    now = 200_000;
    secondCron.resolve({ jobs: [cronJob("current")] });
    secondAuth.resolve(currentAuth);
    await waitForFast(() => expect(element.loadedAtMs).toBe(200_000));
    expect(element.cronJobs.map((job) => job.id)).toEqual(["current"]);
    expect(element.modelAuthStatus).toBe(currentAuth);
    expect(localStorage.getItem(dismissalStoreKey(gateway.connection.gatewayUrl))).not.toBeNull();

    now = 300_000;
    firstCron.resolve({ jobs: [cronJob("stale")] });
    firstAuth.resolve({ ts: 1, providers: [] });
    await Promise.all([firstCron.promise, firstAuth.promise]);
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    await element.updateComplete;

    expect(element.cronJobs.map((job) => job.id)).toEqual(["current"]);
    expect(element.modelAuthStatus).toBe(currentAuth);
    expect(element.loadedAtMs).toBe(200_000);
    expect(localStorage.getItem(dismissalStoreKey(gateway.connection.gatewayUrl))).not.toBeNull();
  });
});

describe("pruneDismissals", () => {
  const chip = (kind: SidebarAttentionKind, signature: string) => ({ kind, signature });

  it("keeps a dismissal while the same entity set is still affected", () => {
    const dismissals = { cronFailed: "alpha\nbeta" };
    expect(pruneDismissals(dismissals, [chip("cronFailed", "alpha\nbeta")])).toBe(dismissals);
  });

  it("drops a dismissal when the affected set changes so the chip resurfaces", () => {
    expect(
      pruneDismissals({ cronFailed: "alpha", modelAuthExpired: "openai" }, [
        chip("cronFailed", "alpha\nbeta"),
        chip("modelAuthExpired", "openai"),
      ]),
    ).toEqual({ modelAuthExpired: "openai" });
  });

  it("drops a dismissal once the underlying state clears", () => {
    expect(pruneDismissals({ cronFailed: "alpha" }, [])).toEqual({});
  });
});

describe("addDismissal", () => {
  function createStorageMock(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges with the persisted map so another tab's dismissal survives", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const key = dismissalStoreKey("ws://gateway.test");
    // Another tab dismissed a cron chip after this tab last loaded.
    localStorage.setItem(key, JSON.stringify({ cronFailed: "alpha" }));

    const next = addDismissal("ws://gateway.test", "modelAuthExpired", "openai");

    const expected = { cronFailed: "alpha", modelAuthExpired: "openai" };
    expect(next).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(expected);
  });
});
