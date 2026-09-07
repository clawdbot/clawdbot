import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
  type TestSessionMenu,
} from "../app-sidebar.ts";

/** Shared by the multi-select and new-group-dialog sidebar cases. */
const MULTI_SELECT_KEYS = ["agent:main:main", "agent:main:a", "agent:main:b", "agent:main:c"];

export function rowLink(sidebar: SidebarLifecycleState, key: string): HTMLAnchorElement {
  const link = sidebar.querySelector<HTMLAnchorElement>(
    `[data-session-key="${key}"] .sidebar-recent-session__link`,
  );
  if (!link) {
    throw new Error(`expected row link for ${key}`);
  }
  return link;
}

export function selectedRowKeys(sidebar: SidebarLifecycleState): string[] {
  return Array.from(sidebar.querySelectorAll(".sidebar-recent-session--selected")).map(
    (row) => row.getAttribute("data-session-key") ?? "",
  );
}

export function click(target: Element, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
}

export function openContextMenu(sidebar: SidebarLifecycleState, key: string) {
  const row = sidebar.querySelector(`[data-session-key="${key}"]`);
  if (!row) {
    throw new Error(`expected row for ${key}`);
  }
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

export async function sessionMenu(sidebar: SidebarLifecycleState): Promise<TestSessionMenu> {
  const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
  if (!menu) {
    throw new Error("expected session menu");
  }
  await menu.updateComplete;
  return menu;
}

export async function mountMultiSelect(methods?: string[] | null, patchManyError?: Error) {
  const harness = createSessionsHarness("main", MULTI_SELECT_KEYS);
  const request = vi.fn((method: string, params?: unknown) => {
    if (method !== "sessions.patchMany") {
      return Promise.reject(new Error(`unexpected request: ${method}`));
    }
    if (patchManyError) {
      return Promise.reject(patchManyError);
    }
    const patchParams = params as {
      targets: Array<{ key: string; agentId?: string }>;
      patch: Record<string, unknown>;
    };
    return harness.patchMany(patchParams.targets, patchParams.patch);
  });
  const gateway = createGatewayHarness({
    request: (method, params) => {
      return request(method, params);
    },
  } as GatewayBrowserClient);
  if (methods !== undefined) {
    gateway.publish({
      phase: "connected",
      hello: {
        features: methods === null ? {} : { methods },
        auth: { role: "operator", scopes: ["operator.write"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
  }
  const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
  sidebar.connected = true;
  await sidebar.updateComplete;
  return { sidebar, harness, request };
}
