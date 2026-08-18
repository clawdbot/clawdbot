import { describe, expect, it } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  getSidebarSessionRow,
  publishSidebarSessionRows,
  unpublishSidebarSessionRows,
} from "./sidebar-session-row-registry.ts";

function sessionRow(
  key: string,
  children: readonly SidebarRecentSession[] = [],
): SidebarRecentSession {
  return { key, label: key, children } as SidebarRecentSession;
}

describe("sidebar session row registry", () => {
  it("replaces one owner's recursively flattened rows without disturbing another owner", () => {
    const gateway = {} as ApplicationGateway;
    const firstOwner = {};
    const secondOwner = {};
    const grandchild = sessionRow("grandchild");
    const child = sessionRow("child", [grandchild]);
    const root = sessionRow("root", [child]);
    const sibling = sessionRow("sibling");

    publishSidebarSessionRows(gateway, firstOwner, [root]);
    publishSidebarSessionRows(gateway, secondOwner, [sibling]);
    expect(getSidebarSessionRow(gateway, "root")).toBe(root);
    expect(getSidebarSessionRow(gateway, "child")).toBe(child);
    expect(getSidebarSessionRow(gateway, "grandchild")).toBe(grandchild);
    expect(getSidebarSessionRow(gateway, "sibling")).toBe(sibling);

    const replacement = sessionRow("replacement");
    publishSidebarSessionRows(gateway, firstOwner, [replacement]);
    expect(getSidebarSessionRow(gateway, "root")).toBeUndefined();
    expect(getSidebarSessionRow(gateway, "replacement")).toBe(replacement);
    expect(getSidebarSessionRow(gateway, "sibling")).toBe(sibling);

    unpublishSidebarSessionRows(gateway, secondOwner);
    expect(getSidebarSessionRow(gateway, "sibling")).toBeUndefined();
    unpublishSidebarSessionRows(gateway, firstOwner);
    expect(getSidebarSessionRow(gateway, "replacement")).toBeUndefined();
  });

  it("isolates the same session key by gateway identity", () => {
    const firstGateway = {} as ApplicationGateway;
    const secondGateway = {} as ApplicationGateway;
    const firstOwner = {};
    const secondOwner = {};
    const firstRow = sessionRow("shared");
    const secondRow = sessionRow("shared");

    publishSidebarSessionRows(firstGateway, firstOwner, [firstRow]);
    publishSidebarSessionRows(secondGateway, secondOwner, [secondRow]);
    expect(getSidebarSessionRow(firstGateway, "shared")).toBe(firstRow);
    expect(getSidebarSessionRow(secondGateway, "shared")).toBe(secondRow);

    unpublishSidebarSessionRows(firstGateway, firstOwner);
    unpublishSidebarSessionRows(secondGateway, secondOwner);
  });
});
