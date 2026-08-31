/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalHistoryResult } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import "./approvals-page.ts";

type TestApprovalsPage = HTMLElement & { updateComplete: Promise<boolean> };

function terminal(id: string, resolvedAtMs: number): ApprovalHistoryResult["items"][number] {
  return {
    id,
    status: "denied",
    presentation: {
      kind: "exec",
      commandText: `echo ${id}`,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    urlPath: `/approve/${id}`,
    createdAtMs: resolvedAtMs - 1_000,
    expiresAtMs: resolvedAtMs + 60_000,
    resolvedAtMs,
    decision: "deny",
    reason: "user",
    source: { agentId: "main", sessionKey: "agent:main:test" },
    resolver: { kind: "device", id: "reviewer-device" },
  };
}

function createPage(
  request: GatewayBrowserClient["request"],
  auth?: { role: string; scopes?: string[] },
): {
  page: TestApprovalsPage;
  emitGatewayEvent: (event: string, payload: unknown) => void;
  updateGateway: (next: Partial<ApplicationGatewaySnapshot>) => void;
} {
  const client = { request } as GatewayBrowserClient;
  let snapshot = {
    phase: "connected",
    client,
    ...(auth ? { hello: { auth } } : {}),
  } as ApplicationGatewaySnapshot;
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  const provider = createApplicationContextProvider({
    basePath: "",
    gateway,
  } as unknown as ApplicationContext);
  const page = document.createElement("openclaw-approvals-page") as TestApprovalsPage;
  provider.append(page);
  document.body.append(provider);
  return {
    page,
    emitGatewayEvent(event, payload) {
      const frame = { event, payload, type: "event" } as GatewayEventFrame;
      for (const listener of eventListeners) {
        listener(frame);
      }
    },
    updateGateway(next) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

async function settle(page: TestApprovalsPage): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await page.updateComplete;
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function stubGrants(
  history: (method: string, params?: unknown) => unknown,
): GatewayBrowserClient["request"] {
  // The page also loads the standing-grant ledger; answer it out of band so
  // history tests keep their ordered mock queues and call counts.
  return ((method: string, params?: unknown) =>
    method === "exec.approval.grants.list"
      ? Promise.resolve({ grants: [] })
      : (history(method, params) as Promise<unknown>)) as GatewayBrowserClient["request"];
}

describe("ApprovalsPage", () => {
  it("loads and renders terminal history, then paginates", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [terminal("first", 2_000)], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [terminal("second", 1_000)] });
    const { page } = createPage(stubGrants(request));

    await settle(page);

    expect(request).toHaveBeenNthCalledWith(1, "approval.history", { limit: 50 });
    const docsLink = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(page.querySelector(".settings-page__intro")).toBeNull();
    expect(docsLink?.href).toBe("https://docs.openclaw.ai/tools/exec-approvals");
    expect(page.querySelectorAll(".approval-history-table tbody tr")).toHaveLength(1);
    expect(page.querySelector(".approval-history-table")?.textContent).toContain("agent:main:test");
    expect(page.querySelector(".approval-history-table")?.textContent).toContain("echo first");
    expect(page.textContent).toContain("rolling 30-day window");

    const loadMore = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Load more"),
    );
    loadMore?.click();
    await settle(page);

    expect(request).toHaveBeenNthCalledWith(2, "approval.history", {
      cursor: "next",
      limit: 50,
    });
    expect(page.querySelectorAll(".approval-history-table tbody tr")).toHaveLength(2);
  });

  it("does not claim an empty history when the load failed", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const { page } = createPage(stubGrants(request));

    await settle(page);

    const body = page.querySelector(".approval-history-table tbody")?.textContent ?? "";
    expect(body).not.toContain("No resolved approvals");
  });

  it("shows the empty message only after a successful zero-row load", async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [] });
    const { page } = createPage(stubGrants(request));

    await settle(page);

    const body = page.querySelector(".approval-history-table tbody")?.textContent ?? "";
    expect(body).toContain("No resolved approvals");
  });

  it.each([
    { kind: "exec", event: "exec.approval.resolved" },
    { kind: "plugin", event: "plugin.approval.resolved" },
    { kind: "system-agent", event: "openclaw.approval.resolved" },
  ])("shows a newly resolved $kind approval without leaving the page", async ({ event }) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [terminal("newly-resolved", 2_000)] });
    const { page, emitGatewayEvent } = createPage(stubGrants(request));

    await settle(page);
    expect(page.querySelector(".approval-history-table")?.textContent).toContain(
      "No resolved approvals",
    );

    emitGatewayEvent(event, { id: "newly-resolved", decision: "deny" });
    await settle(page);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("approval.history", { limit: 50 });
    expect(page.querySelector(".approval-history-table")?.textContent).toContain(
      "echo newly-resolved",
    );
  });

  it("refreshes the newest history after an approval resolves during pagination", async () => {
    let resolveOlderPage!: (result: ApprovalHistoryResult) => void;
    const olderPage = new Promise<ApprovalHistoryResult>((resolve) => {
      resolveOlderPage = resolve;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [terminal("first", 2_000)], nextCursor: "next" })
      .mockReturnValueOnce(olderPage)
      .mockResolvedValueOnce({ items: [terminal("newest", 3_000), terminal("first", 2_000)] });
    const { page, emitGatewayEvent } = createPage(stubGrants(request));

    await settle(page);
    const loadMore = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Load more"),
    );
    loadMore?.click();
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);

    emitGatewayEvent("exec.approval.resolved", { id: "newest", decision: "deny" });
    expect(request).toHaveBeenCalledTimes(2);

    resolveOlderPage({ items: [terminal("older", 1_000)] });
    await settle(page);
    await settle(page);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("approval.history", { limit: 50 });
    expect(page.querySelector(".approval-history-table")?.textContent).toContain("echo newest");
  });

  it.each([
    { name: "read-only", scopes: ["operator.read"] },
    { name: "write-only", scopes: ["operator.write"] },
  ])("does not request or render approval history for a $name operator", async ({ scopes }) => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const { page } = createPage(stubGrants(request), {
      role: "operator",
      scopes,
    });

    await settle(page);

    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".approval-history-table")).toBeNull();
    expect(page.querySelector('[role="status"]')?.textContent).toContain("operator.approvals");
  });

  it.each([
    { name: "reviewer", auth: { role: "operator", scopes: ["operator.approvals"] } },
    { name: "admin", auth: { role: "operator", scopes: ["operator.admin"] } },
    { name: "legacy operator", auth: { role: "operator" } },
  ])("loads approval history for a $name", async ({ auth }) => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const { page } = createPage(stubGrants(request), auth);

    await settle(page);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("approval.history", { limit: 50 });
    expect(page.querySelector(".approval-history-table")).not.toBeNull();
  });

  it("discards stale history when approval access changes on the same gateway", async () => {
    let resolveStaleHistory!: (result: ApprovalHistoryResult) => void;
    const staleHistory = new Promise<ApprovalHistoryResult>((resolve) => {
      resolveStaleHistory = resolve;
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(staleHistory)
      .mockResolvedValueOnce({ items: [terminal("current", 2_000)] });
    const { page, emitGatewayEvent, updateGateway } = createPage(stubGrants(request), {
      role: "operator",
      scopes: ["operator.approvals"],
    });

    await settle(page);
    expect(request).toHaveBeenCalledOnce();

    updateGateway({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);
    emitGatewayEvent("exec.approval.resolved", { id: "inaccessible", decision: "deny" });
    await settle(page);
    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector(".approval-history-table")).toBeNull();

    updateGateway({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.querySelector(".approval-history-table")?.textContent).toContain("echo current");

    resolveStaleHistory({ items: [terminal("stale", 1_000)] });
    await settle(page);
    expect(page.querySelector(".approval-history-table")?.textContent).toContain("echo current");
    expect(page.querySelector(".approval-history-table")?.textContent).not.toContain("echo stale");
  });

  it("renders the standing-grant ledger and revokes through the gateway", async () => {
    const history = vi.fn().mockResolvedValue({ items: [] });
    const grant = {
      grantId: "grant-1",
      agentId: "main",
      cronJobId: "job-1",
      cronJobName: "Nightly backup",
      command: "id -un",
      cwd: null,
      createdAtMs: 1_000,
      expiresAtMs: null,
      revokedAtMs: null,
      revokedBy: null,
      lastUsedAtMs: null,
      useCount: 3,
    };
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "exec.approval.grants.list") {
        return Promise.resolve({ grants: [grant] });
      }
      if (method === "exec.approval.grants.revoke") {
        return Promise.resolve({ outcome: "revoked", params });
      }
      return history(method, params) as Promise<unknown>;
    });
    const { page } = createPage(request as unknown as GatewayBrowserClient["request"]);

    await settle(page);
    await settle(page);

    const ledger = page.querySelector(".standing-grants-table");
    expect(ledger?.textContent).toContain("Nightly backup");
    expect(ledger?.textContent).toContain("id -un");
    expect(ledger?.textContent).toContain("Until revoked");

    const revoke = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Revoke"),
    );
    revoke?.click();
    await settle(page);

    expect(request).toHaveBeenCalledWith("exec.approval.grants.revoke", { grantId: "grant-1" });
    expect(page.querySelector(".standing-grants-table")?.textContent).toContain("Revoked");
  });
});
