import { describe, expect, it } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelOperationOwnership } from "./browser-panel-operation-ownership.ts";

describe("BrowserPanelOperationOwnership", () => {
  it("releases navigation commits when tabs reconcile, close, or leave an accepted snapshot", () => {
    const { client } = createBrowserClient(async () => ({}));
    const ownership = new BrowserPanelOperationOwnership(new TestBrowserPanelHost(client));
    ownership.markNavigationCommitted(client, "tab-a");
    ownership.markNavigationCommitted(client, "tab-b");

    ownership.retainTabSnapshot(client, [
      { id: "tab-a", targetId: "raw-a", title: "A", url: "https://a.example" },
    ]);
    expect(ownership.hasUnreconciledNavigation(client, "tab-a")).toBe(true);
    expect(ownership.hasUnreconciledNavigation(client, "tab-b")).toBe(false);

    ownership.forgetNavigation(client, "tab-a");
    expect(ownership.hasUnreconciledNavigation(client, "tab-a")).toBe(false);

    ownership.markNavigationCommitted(client, "tab-a");
    ownership.markNavigationReconciled(client, "tab-a");
    expect(ownership.hasUnreconciledNavigation(client, "tab-a")).toBe(false);
  });

  it("reconciles captured metadata without replacing an unchanged tab list", () => {
    const { client } = createBrowserClient(async () => ({}));
    const ownership = new BrowserPanelOperationOwnership(new TestBrowserPanelHost(client));
    const tabs = [{ id: "tab-a", targetId: "raw-a", title: "A", url: "https://a.example" }];
    const metrics = createBrowserPanelTestMetrics("https://b.example", "B").result;

    const reconciled = ownership.capturedTabs(tabs, "tab-a", metrics, metrics.url);
    expect(reconciled).toEqual([
      { id: "tab-a", targetId: "raw-a", title: "B", url: "https://b.example" },
    ]);
    expect(ownership.capturedTabs(reconciled, "tab-a", metrics, metrics.url)).toBe(reconciled);
  });
});
