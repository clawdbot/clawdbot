import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { expect } from "vitest";
import type { createBrowserRouteDispatcher } from "../src/browser/routes/dispatcher.js";

type Tab = {
  id: number;
  url: string;
  groupId: number;
  incognito: boolean;
  active: boolean;
  windowId: number;
};
declare const chrome: {
  tabs: { query(query: object): Promise<Tab[]> };
  tabGroups: { get(id: number): Promise<{ title: string }> };
  debugger: { getTargets(): Promise<Array<{ id: string; tabId?: number }>> };
};

/** Exercise route-owned creation through the relay; direct Chrome only observes the outcome. */
export async function assertRelayTabCreation(params: {
  context: BrowserContext;
  extensionPage: Page;
  dispatcher: ReturnType<typeof createBrowserRouteDispatcher>;
  url: string;
  accessMode: "all" | "selected";
}) {
  const { context, extensionPage, dispatcher, url, accessMode } = params;
  const existingPages = await Promise.all(
    context.pages().map(async (page) => ({ page, url: page.url(), title: await page.title() })),
  );
  const existingTabs = await extensionPage.evaluate(async () => await chrome.tabs.query({}));
  const createdPages: Array<{ page: Page; initialUrl: string }> = [];
  const onPage = (page: Page) => createdPages.push({ page, initialUrl: page.url() });
  context.on("page", onPage);
  try {
    const opened = await dispatcher.dispatch({
      method: "POST",
      path: "/tabs/open",
      query: { profile: "e2e" },
      body: { url },
    });
    await expect.poll(() => createdPages.length, { message: JSON.stringify(opened) }).toBe(1);
    const created = createdPages[0];
    assert(created);
    // Playwright reports the page before the extension's tab index lists it;
    // a single query here raced and saw zero new tabs on hosted runners.
    const queryNewTabs = async () => {
      const tabs = await extensionPage.evaluate(async () => await chrome.tabs.query({}));
      return { tabs, newTabs: tabs.filter((tab) => !existingTabs.some((e) => e.id === tab.id)) };
    };
    await expect.poll(async () => (await queryNewTabs()).newTabs.length).toBe(1);
    const { tabs, newTabs } = await queryNewTabs();
    const unchanged = await Promise.all(
      existingPages.map(
        async ({ page, url: previousUrl, title }) =>
          !page.isClosed() && page.url() === previousUrl && (await page.title()) === title,
      ),
    );
    const evidence = {
      accessMode,
      requestedUrl: url,
      response: opened,
      initialUrl: created.initialUrl,
      finalUrl: created.page.url(),
      newTabs: newTabs.map(({ id, url: tabUrl, groupId, incognito }) => ({
        id,
        url: tabUrl,
        groupId,
        incognito,
      })),
      unrelatedPagesUnchanged: unchanged.every(Boolean),
    };
    const artifact = path.resolve(
      `.artifacts/browser-creation/creation-local-after-${accessMode}.json`,
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stderr.write(`[browser-creation-e2e] ${JSON.stringify(evidence)}\n`);
    expect(unchanged.every(Boolean)).toBe(true);
    for (const tab of existingTabs) {
      expect(tabs.find((current) => current.id === tab.id)).toMatchObject({
        url: tab.url,
        groupId: tab.groupId,
        incognito: tab.incognito,
        active: tab.active,
        windowId: tab.windowId,
      });
    }
    expect(newTabs).toHaveLength(1);
    const createdTab = newTabs[0];
    assert(createdTab);
    expect(createdTab.incognito).toBe(false);
    expect(
      await extensionPage.evaluate(
        async (id) => await chrome.tabGroups.get(id),
        createdTab.groupId,
      ),
    ).toMatchObject({ title: "OpenClaw" });
    expect(created.initialUrl).toBe("about:blank");
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const body = opened.body as { targetId: string };
    expect(opened.body).toMatchObject({
      targetId: expect.any(String),
      url,
      resolvedProfile: "e2e",
    });
    const targets = await extensionPage.evaluate(async () => await chrome.debugger.getTargets());
    expect(targets.find((target) => target.tabId === createdTab.id)?.id).toBe(body.targetId);
    expect(created.page.url()).toBe(url);
    expect(await created.page.title()).toBe("OpenClaw selected tab");
    const snapshot = await dispatcher.dispatch({
      method: "GET",
      path: "/snapshot",
      query: { profile: "e2e", targetId: body.targetId, format: "ai" },
    });
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    expect(snapshot.body).toMatchObject({
      targetId: body.targetId,
      snapshot: expect.stringContaining("OpenClaw created destination"),
    });
    await fs.writeFile(
      artifact,
      `${JSON.stringify({ ...evidence, snapshotStatus: snapshot.status, snapshotTargetId: body.targetId }, null, 2)}\n`,
    );
    process.stderr.write(`[browser-creation-e2e] mode=${accessMode} same-target-snapshot=200\n`);
  } finally {
    context.off("page", onPage);
    await Promise.all(createdPages.map(async ({ page }) => await page.close()));
    expect(createdPages.every(({ page }) => page.isClosed())).toBe(true);
    process.stderr.write(
      `[browser-creation-e2e] mode=${accessMode} created-pages-closed=${createdPages.length}\n`,
    );
  }
}
