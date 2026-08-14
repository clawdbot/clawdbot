import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

const sectionSelector = '[data-session-section="ungrouped"]';

function publish(
  harness: ReturnType<typeof createSessionsHarness>,
  rows: GatewaySessionRow[],
): void {
  harness.publishList({
    result: {
      ts: 2,
      path: "",
      count: rows.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: rows,
    } satisfies SessionsListResult,
  });
}

function plainRow(key: string, overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, kind: "direct", label: key, updatedAt: 2, ...overrides };
}

async function mountWithRows(rows: GatewaySessionRow[]) {
  const key = rows[0]?.key ?? "agent:main:only";
  const harness = createSessionsHarness("main", [key]);
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  publish(harness, rows);
  await sidebar.updateComplete;
  return sidebar;
}

describe("AppSidebar section grammar", () => {
  it("places the disclosure immediately after the section label", async () => {
    const sidebar = await mountWithRows([plainRow("agent:main:one")]);

    const toggle = sidebar.querySelector(`${sectionSelector} .sidebar-session-group-toggle`);
    const label = toggle?.querySelector(".sidebar-recent-sessions__label-text");
    const chevron = toggle?.querySelector(".sidebar-session-group-toggle__icon");

    expect(label).not.toBeNull();
    expect(chevron).not.toBeNull();
    expect(label?.nextElementSibling).toBe(chevron);
  });

  it("marks the disclosure collapsed so it can rest visible without hover", async () => {
    const sidebar = await mountWithRows([plainRow("agent:main:one")]);
    const chevron = () =>
      sidebar.querySelector(`${sectionSelector} .sidebar-session-group-toggle__icon`);

    expect(chevron()?.classList.contains("sidebar-session-group-toggle__icon--collapsed")).toBe(
      false,
    );

    sidebar
      .querySelector<HTMLButtonElement>(`${sectionSelector} .sidebar-session-group-toggle`)
      ?.click();
    await sidebar.updateComplete;

    expect(chevron()?.classList.contains("sidebar-session-group-toggle__icon--collapsed")).toBe(
      true,
    );
  });

  it("keeps status last in the head so revealed actions never displace it", async () => {
    const sidebar = await mountWithRows([
      plainRow("agent:main:blocked", {
        status: "failed",
        endedAt: 2,
        lastRunError: "Provider credits exhausted",
      }),
    ]);

    sidebar
      .querySelector<HTMLButtonElement>(`${sectionSelector} .sidebar-session-group-toggle`)
      ?.click();
    await sidebar.updateComplete;

    const head = sidebar.querySelector(`${sectionSelector} .sidebar-recent-sessions__head`);
    const status = head?.querySelector("[data-section-status]");
    expect(status).not.toBeNull();
    expect(head?.lastElementChild).toBe(status);
  });

  it("drops the redundant row count once a status dot carries the attention", async () => {
    const sidebar = await mountWithRows([
      plainRow("agent:main:blocked", {
        status: "failed",
        endedAt: 2,
        lastRunError: "Provider credits exhausted",
      }),
    ]);
    const section = () => sidebar.querySelector(sectionSelector);

    sidebar
      .querySelector<HTMLButtonElement>(`${sectionSelector} .sidebar-session-group-toggle`)
      ?.click();
    await sidebar.updateComplete;

    expect(section()?.querySelector('[data-section-status="attention"]')).not.toBeNull();
    expect(section()?.querySelector(".sidebar-session-group-count")).toBeNull();
  });

  it("counts a collapsed section that has nothing to flag", async () => {
    const sidebar = await mountWithRows([plainRow("agent:main:one"), plainRow("agent:main:two")]);

    sidebar
      .querySelector<HTMLButtonElement>(`${sectionSelector} .sidebar-session-group-toggle`)
      ?.click();
    await sidebar.updateComplete;

    const section = sidebar.querySelector(sectionSelector);
    expect(section?.querySelector("[data-section-status]")).toBeNull();
    expect(section?.querySelector(".sidebar-session-group-count")?.textContent?.trim()).toBe("2");
  });

  it("gives a movable group the shared grip glyph", async () => {
    const sidebar = await mountWithRows([plainRow("agent:main:one")]);

    const handle = sidebar.querySelector(`${sectionSelector} .sidebar-session-group-drag-handle`);
    expect(handle?.querySelector("svg")).not.toBeNull();
  });
});
