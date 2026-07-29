/* @vitest-environment jsdom */

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
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { ApprovalPage } from "./approval-page.ts";

const TEST_ELEMENT_SUFFIX = crypto.randomUUID();
const APPROVAL_PAGE_ELEMENT_NAME = `test-openclaw-approval-page-${TEST_ELEMENT_SUFFIX}`;

// The non-isolated UI runner resets modules but not customElements. Register
// the current page graph so context and locale state stay paired.
customElements.define(APPROVAL_PAGE_ELEMENT_NAME, class extends ApprovalPage {});

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

function createGateway(
  client: GatewayBrowserClient,
  connected = true,
  hello: ApplicationGatewaySnapshot["hello"] = {
    auth: { role: "operator" },
  } as ApplicationGatewaySnapshot["hello"],
) {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
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
  hello?: ApplicationGatewaySnapshot["hello"];
  id?: string;
  withBootFallback?: boolean;
}) {
  const source = createGateway(params.client, params.connected, params.hello);
  const page = document.createElement(APPROVAL_PAGE_ELEMENT_NAME) as TestApprovalPage;
  const provider = createApplicationContextProvider({
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
  it("keeps a no-auth approval readable without enabling its decisions", async () => {
    const request = vi.fn(
      async (_method: string) => ({ approval: pendingApproval() }) satisfies ApprovalGetResult,
    );
    const { page } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: null,
    });

    await settle(page);

    const decision = page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement;
    expect(request).toHaveBeenCalledWith("approval.get", { id: "exec:approval-1" });
    expect(page.querySelector(".approval-page__preview")?.textContent).toBe("printf safe");
    expect(decision.disabled).toBe(true);
    decision.click();
    await settle(page);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "approval.resolve")).toBe(false);
  });

  it.each([
    { name: "read-only", scopes: ["operator.read"] },
    { name: "write-only", scopes: ["operator.write"] },
    { name: "explicitly ungranted", scopes: [] },
  ])("does not request or disclose a durable approval to a $name operator", async ({ scopes }) => {
    const request = vi.fn(async () => ({ approval: pendingApproval() }));
    const { page } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: {
        auth: { role: "operator", scopes },
      } as ApplicationGatewaySnapshot["hello"],
    });

    await settle(page);

    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".approval-page")?.getAttribute("data-state")).toBe("missing-scope");
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("operator.approvals");
    expect(page.querySelector(".approval-page__preview")).toBeNull();
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it.each([
    { name: "reviewer", auth: { role: "operator", scopes: ["operator.approvals"] } },
    { name: "administrator", auth: { role: "operator", scopes: ["operator.admin"] } },
    { name: "legacy authenticated operator", auth: { role: "operator" } },
  ])("loads a durable approval for a $name", async ({ auth }) => {
    const request = vi.fn(async () => ({ approval: pendingApproval() }));
    const { page } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: { auth } as ApplicationGatewaySnapshot["hello"],
    });

    await settle(page);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("approval.get", { id: "exec:approval-1" });
    expect(page.querySelector('[data-decision="allow-once"]')).not.toBeNull();
  });

  it.each([
    { name: "reviewer", scopes: ["operator.approvals"] },
    { name: "administrator", scopes: ["operator.admin"] },
  ])("allows an authenticated $name to resolve a durable approval", async ({ scopes }) => {
    const request = vi.fn(
      async (method: string): Promise<unknown> =>
        method === "approval.get"
          ? ({ approval: pendingApproval() } satisfies ApprovalGetResult)
          : ({ applied: true, approval: allowedApproval() } satisfies ApprovalResolveResult),
    );
    const { page } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);

    (page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).click();
    await settle(page);

    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: "exec:approval-1",
      kind: "exec",
      decision: "allow-once",
    });
    expect(page.querySelector("h1")?.textContent).toBe("Approved here");
  });

  it("rejects an in-flight resolution when only the approval grant is revoked", async () => {
    let resolveDecision!: (value: ApprovalResolveResult) => void;
    const staleDecision = new Promise<ApprovalResolveResult>((resolve) => {
      resolveDecision = resolve;
    });
    const request = vi.fn(
      (method: string): Promise<unknown> =>
        method === "approval.get"
          ? Promise.resolve({ approval: pendingApproval() } satisfies ApprovalGetResult)
          : staleDecision,
    );
    const { page, source } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);
    (page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).click();
    await page.updateComplete;

    source.update({ hello: null });
    await settle(page);
    expect(page.querySelector(".approval-page__preview")?.textContent).toBe("printf safe");
    expect((page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).disabled).toBe(
      true,
    );

    resolveDecision({ applied: true, approval: allowedApproval() });
    await settle(page);

    expect(page.querySelector(".approval-page__preview")?.textContent).toBe("printf safe");
    expect(page.querySelector("h1")?.textContent).not.toBe("Approved here");
    expect(request.mock.calls.filter(([method]) => method === "approval.resolve")).toHaveLength(1);
  });

  it("redacts a pending approval and rejects a retained action after a scope downgrade", async () => {
    const request = vi.fn(
      async (_method: string) => ({ approval: pendingApproval() }) satisfies ApprovalGetResult,
    );
    const { page, source } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);
    const staleDecision = page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement;

    source.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    staleDecision.click();
    await settle(page);

    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector(".approval-page")?.getAttribute("data-state")).toBe("missing-scope");
    expect(page.querySelector(".approval-page__preview")).toBeNull();
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
    expect(request.mock.calls.some(([method]) => method === "approval.resolve")).toBe(false);
  });

  it("redacts approval details when one snapshot disconnects and revokes access", async () => {
    const request = vi.fn(async () => ({ approval: pendingApproval() }));
    const { page, source } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);
    expect(page.querySelector(".approval-page__preview")?.textContent).toBe("printf safe");

    source.update({
      phase: "stopped",
      client: null,
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);

    expect(page.querySelector(".approval-page__preview")).toBeNull();
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
    expect(page.textContent).not.toContain("printf safe");
    expect(page.querySelector(".approval-page")?.getAttribute("data-state")).toBe(
      "connection-error",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a pre-revocation lookup when approval access is restored", async () => {
    let resolveStale!: (value: ApprovalGetResult) => void;
    const staleLookup = new Promise<ApprovalGetResult>((resolve) => {
      resolveStale = resolve;
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(staleLookup)
      .mockResolvedValueOnce({ approval: allowedApproval() } satisfies ApprovalGetResult);
    const { page, source } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);

    source.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    source.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);
    resolveStale({ approval: pendingApproval() });
    await settle(page);

    expect(request).toHaveBeenCalledTimes(2);
    expect(page.querySelector("h1")?.textContent).toBe("Approved");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

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

  it("renders reviewer-only plugin detail in a preformatted block", async () => {
    const approval = pendingApproval({
      id: "plugin:approval-1",
      urlPath: "/approve/plugin%3Aapproval-1",
      presentation: {
        kind: "plugin",
        title: "Claude native tool: Bash",
        description: '{"command":"printf …"}',
        detail: '{"command":"printf \\\"line one\\nline two\\\""}',
        severity: "warning",
        pluginId: "claude-cli",
        toolName: "Bash",
        agentId: "main",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    const request = vi.fn(async () => ({ approval }) satisfies ApprovalGetResult);
    const { page } = createPage({
      client: { request } as unknown as GatewayBrowserClient,
      id: approval.id,
    });

    await settle(page);

    expect(page.querySelector("pre.approval-page__preview.mono")?.textContent).toBe(
      approval.presentation.kind === "plugin" ? approval.presentation.detail : undefined,
    );
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

    source.update({ phase: "reconnecting" });
    source.update({ phase: "connected" });
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

    source.update({ phase: "reconnecting" });
    await page.updateComplete;

    expect(page.querySelector(".approval-page__preview")?.textContent).toBe("printf safe");
    expect((page.querySelector('[data-decision="allow-once"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(page.textContent).toContain("Connection interrupted");
  });
});
