/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AllowedApprovalSnapshot,
  ApprovalGetResult,
  ApprovalResolveResult,
  ExpiredApprovalSnapshot,
  PendingApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { applicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import "./approval-page.ts";

const PROVIDER_ELEMENT_NAME = "test-approval-page-context-provider";

class ApprovalPageContextProvider extends LitElement {
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });

  setContext(context: ApplicationContext) {
    this.contextProvider.setValue(context);
  }
}

if (!customElements.get(PROVIDER_ELEMENT_NAME)) {
  customElements.define(PROVIDER_ELEMENT_NAME, ApprovalPageContextProvider);
}

type TestApprovalPage = HTMLElement & {
  approvalId: string;
  updateComplete: Promise<boolean>;
};

function pendingApproval(
  overrides: Partial<PendingApprovalSnapshot> = {},
): PendingApprovalSnapshot {
  return {
    id: "exec:approval-1",
    urlPath: "/approve/exec%3Aapproval-1",
    status: "pending",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    presentation: {
      kind: "exec",
      commandText: "printf safe",
      commandPreview: "printf …",
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
    ...overrides,
  } as PendingApprovalSnapshot;
}

function allowedApproval(
  overrides: Partial<AllowedApprovalSnapshot> = {},
): AllowedApprovalSnapshot {
  return {
    ...pendingApproval(),
    status: "allowed",
    decision: "allow-once",
    reason: "user",
    resolvedAtMs: 2_000,
    ...overrides,
  } as AllowedApprovalSnapshot;
}

function expiredApproval(): ExpiredApprovalSnapshot {
  return {
    ...pendingApproval(),
    status: "expired",
    reason: "timeout",
    resolvedAtMs: 2_000,
  } as ExpiredApprovalSnapshot;
}

function createGateway(client: GatewayBrowserClient, connected = true) {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    gateway,
    update(patch: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createPage(params: {
  client: GatewayBrowserClient;
  connected?: boolean;
  id?: string;
  withBootFallback?: boolean;
}) {
  const source = createGateway(params.client, params.connected);
  const provider = document.createElement(PROVIDER_ELEMENT_NAME) as ApprovalPageContextProvider;
  const page = document.createElement("openclaw-approval-page") as TestApprovalPage;
  provider.setContext({
    basePath: "",
    gateway: source.gateway,
  } as unknown as ApplicationContext);
  page.approvalId = params.id ?? "exec:approval-1";
  if (params.withBootFallback) {
    const fallback = document.createElement("main");
    fallback.className = "approval-page approval-page--booting";
    page.append(fallback);
  }
  provider.append(page);
  document.body.append(provider);
  return { page, source };
}

async function settle(page: TestApprovalPage) {
  await Promise.resolve();
  await Promise.resolve();
  await page.updateComplete;
}

let visibilityState: DocumentVisibilityState;

beforeEach(async () => {
  await i18n.setLocale("en");
  visibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

describe("ApprovalPage", () => {
  it("replaces the host boot fallback instead of duplicating the page", async () => {
    const request = vi.fn(async () => ({ approval: pendingApproval() }));
    const { page } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      withBootFallback: true,
    });

    await settle(page);

    expect(page.querySelectorAll(".approval-page")).toHaveLength(1);
    expect(page.querySelector(".approval-page--booting")).toBeNull();
  });

  it("loads a durable approval and sends a kind-bound resolution", async () => {
    const pending = pendingApproval();
    const terminal = allowedApproval();
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "approval.get") {
        return { approval: pending } satisfies ApprovalGetResult;
      }
      return { applied: true, approval: terminal } satisfies ApprovalResolveResult;
    });
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });

    await settle(page);

    expect(request).toHaveBeenCalledWith("approval.get", { id: pending.id });
    expect(page.querySelector(".approval-page__status")?.textContent).toContain(
      "Waiting for your decision",
    );
    expect(page.querySelector(".approval-page__preview")?.textContent).toBe("printf safe");

    (page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).click();
    await settle(page);

    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: pending.id,
      kind: "exec",
      decision: "allow-once",
    });
    expect(page.querySelector("h1")?.textContent).toBe("Approved here");
    expect(document.activeElement).toBe(page.querySelector("h1"));
  });

  it("keeps the selected decision named while a resolution is in flight", async () => {
    let resolveRequest!: (result: ApprovalResolveResult) => void;
    const pending = pendingApproval();
    const request = vi.fn((method: string): Promise<unknown> => {
      if (method === "approval.get") {
        return Promise.resolve({ approval: pending } satisfies ApprovalGetResult);
      }
      return new Promise<ApprovalResolveResult>((resolve) => {
        resolveRequest = resolve;
      });
    });
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });
    await settle(page);

    (page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).click();
    await page.updateComplete;

    const allowButton = page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement;
    const denyButton = page.querySelector('[data-decision="deny"]') as HTMLButtonElement;
    expect(allowButton.textContent?.trim()).toBe("Recording Allow once…");
    expect(denyButton.textContent?.trim()).toBe("Deny");
    expect(allowButton.disabled).toBe(true);
    expect(denyButton.disabled).toBe(true);

    resolveRequest({ applied: true, approval: allowedApproval() });
    await settle(page);
  });

  it("formats approval times with the selected Control UI locale", async () => {
    await i18n.setLocale("de");
    const approval = pendingApproval();
    const request = vi.fn(async () => ({ approval }) satisfies ApprovalGetResult);
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });

    await settle(page);

    const expected = new Intl.DateTimeFormat("de", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(approval.expiresAtMs));
    expect(page.querySelector("time")?.textContent?.trim()).toBe(expected);
  });

  it("shows the canonical winner when another surface resolves first", async () => {
    const pending = pendingApproval();
    const terminal = allowedApproval();
    const request = vi.fn(
      async (method: string): Promise<unknown> =>
        method === "approval.get"
          ? ({ approval: pending } satisfies ApprovalGetResult)
          : ({ applied: false, approval: terminal } satisfies ApprovalResolveResult),
    );
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });
    await settle(page);

    (page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).click();
    await settle(page);

    expect(page.querySelector("h1")?.textContent).toBe("Resolved elsewhere");
    expect(page.textContent).toContain("Another surface or an earlier attempt");
  });

  it("renders a fail-closed timeout distinctly from another surface's decision", async () => {
    const pending = pendingApproval();
    const expired = expiredApproval();
    const request = vi.fn(
      async (method: string): Promise<unknown> =>
        method === "approval.get"
          ? ({ approval: pending } satisfies ApprovalGetResult)
          : ({ applied: false, approval: expired } satisfies ApprovalResolveResult),
    );
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });
    await settle(page);

    (page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).click();
    await settle(page);

    expect(page.querySelector("h1")?.textContent).toBe("Expired");
    expect(page.textContent).toContain("No decision arrived before the deadline");
  });

  it("fails closed when the Gateway returns a malformed projection", async () => {
    const request = vi.fn(async () => ({ approval: { status: "pending" } }));
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });

    await settle(page);

    expect(page.querySelector("h1")?.textContent).toBe("Approval unavailable");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it("reconciles canonical state when an applied result does not match the submitted decision", async () => {
    const pending = pendingApproval();
    const mismatched = allowedApproval();
    const canonical = expiredApproval();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ approval: pending } satisfies ApprovalGetResult)
      .mockResolvedValueOnce({
        applied: true,
        approval: mismatched,
      } satisfies ApprovalResolveResult)
      .mockResolvedValueOnce({ approval: canonical } satisfies ApprovalGetResult);
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });
    await settle(page);

    (page.querySelector('[data-decision="deny"]') as HTMLButtonElement).click();
    await settle(page);

    expect(request).toHaveBeenCalledTimes(3);
    expect(page.querySelector("h1")?.textContent).toBe("Expired");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it("ignores an older lookup after a same-client reconnect", async () => {
    let resolveFirst!: (value: ApprovalGetResult) => void;
    const first = new Promise<ApprovalGetResult>((resolve) => {
      resolveFirst = resolve;
    });
    const terminal = allowedApproval();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ approval: terminal } satisfies ApprovalGetResult);
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, source } = createPage({ client });
    await settle(page);

    source.update({ connected: false, reconnecting: true });
    source.update({ connected: true, reconnecting: false });
    await settle(page);
    resolveFirst({ approval: pendingApproval() });
    await settle(page);

    expect(request).toHaveBeenCalledTimes(2);
    expect(page.querySelector("h1")?.textContent).toBe("Approved");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it("polls only while the pending document is visible", async () => {
    vi.useFakeTimers();
    const pending = pendingApproval({ expiresAtMs: Date.now() + 60_000 });
    const request = vi.fn(async () => ({ approval: pending }) satisfies ApprovalGetResult);
    const { page } = createPage({ client: { request } as unknown as GatewayBrowserClient });
    await settle(page);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request).toHaveBeenCalledTimes(2);

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps one connection alert and disabled decisions across failed background polls", async () => {
    vi.useFakeTimers();
    const pending = pendingApproval({ expiresAtMs: Date.now() + 60_000 });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ approval: pending } satisfies ApprovalGetResult)
      .mockRejectedValue(new Error("temporary Gateway failure"));
    const { page } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
    });
    await settle(page);

    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    const alert = page.querySelector(".approval-page__callout");
    expect(alert).not.toBeNull();
    expect((page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).disabled).toBe(
      true,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
    expect(page.querySelector(".approval-page__callout")).toBe(alert);
  });

  it("keeps pending context but disables decisions during reconnect", async () => {
    const pending = pendingApproval();
    const request = vi.fn(async () => ({ approval: pending }) satisfies ApprovalGetResult);
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, source } = createPage({ client });
    await settle(page);

    source.update({ connected: false, reconnecting: true });
    await page.updateComplete;

    expect(page.querySelector(".approval-page__preview")?.textContent).toBe("printf safe");
    expect((page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(page.textContent).toContain("Connection interrupted");
  });
});
