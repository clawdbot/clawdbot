/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalHistoryResult } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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

function createPage(request: GatewayBrowserClient["request"]): TestApprovalsPage {
  const client = { request } as GatewayBrowserClient;
  const snapshot = { connected: true, client } as ApplicationGatewaySnapshot;
  const gateway = {
    snapshot,
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  const provider = createApplicationContextProvider({
    basePath: "",
    gateway,
  } as unknown as ApplicationContext);
  const page = document.createElement("openclaw-approvals-page") as TestApprovalsPage;
  provider.append(page);
  document.body.append(provider);
  return page;
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

describe("ApprovalsPage", () => {
  it("loads and renders terminal history, then paginates", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [terminal("first", 2_000)], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [terminal("second", 1_000)] });
    const page = createPage(request as GatewayBrowserClient["request"]);

    await settle(page);

    expect(request).toHaveBeenNthCalledWith(1, "approval.history", { limit: 50 });
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
    const page = createPage(request as GatewayBrowserClient["request"]);

    await settle(page);

    const body = page.querySelector(".approval-history-table tbody")?.textContent ?? "";
    expect(body).not.toContain("No resolved approvals");
  });

  it("shows the empty message only after a successful zero-row load", async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [] });
    const page = createPage(request as GatewayBrowserClient["request"]);

    await settle(page);

    const body = page.querySelector(".approval-history-table tbody")?.textContent ?? "";
    expect(body).toContain("No resolved approvals");
  });
});
