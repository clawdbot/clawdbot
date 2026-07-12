// Wire-as-you-go integration test for the workspace UI <-> gateway seam.
//
// The two P1 contract bugs that shipped green did so because every existing test
// mocked exactly ONE side of the boundary: the gateway suite drove handlers with
// hand-built params, and the UI suite drove client fns against a canned mock
// `request`. Neither exercised the REAL client param-builder against the REAL
// handler against a REAL store, so drift between them was invisible.
//
// This test closes that gap. It is node-rooted so it can import the UI `.ts`
// client and wires three real components with NO mocked responses:
//   1. a real WorkspaceStore over a temp stateDir, seeded via the store's real
//      replace() API, plus a real JSON data file under `<stateDir>/workspace/data`;
//   2. the real gateway handlers from registerWorkspaceGatewayMethods();
//   3. the real Control-UI client fns (resolveBinding / setWidgetCollapsed /
//      moveWidget / removeWidgetFromTab / updateWidgetTitle) from
//      ui/src/lib/workspace/index.ts.
// The fake GatewayBrowserClient is REAL-ROUTING: its request(method, params)
// looks up the matching registered handler, invokes it with a captured respond,
// and resolves/throws from the actual respond payload — so real client params
// flow into the real handler into the real store, and we read the store back to
// prove the round-trip landed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  getWorkspaceState,
  loadWorkspace,
  moveWidget,
  removeWidgetFromTab,
  resolveBinding,
  setWidgetCollapsed,
  updateWidgetTitle,
} from "../../../ui/src/lib/workspace/index.ts";
import { registerWorkspaceGatewayMethods } from "./gateway.js";
import type { WorkspaceWidget, WorkspaceDoc } from "./schema.js";
import { WorkspaceStore } from "./store.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type MethodOpts = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
type RegisteredMethods = Map<string, { handler: Handler; opts: MethodOpts }>;
// The GatewayBrowserClient shape the UI client fns require, derived from a real
// signature so we never mock its type — we build a real-routing stand-in for it.
type RoutingClient = NonNullable<Parameters<typeof loadWorkspace>[1]>;

// One tab + one widget, seeded through the store's real replace() API.
const SEED_DOC: WorkspaceDoc = {
  schemaVersion: 1,
  workspaceVersion: 0,
  tabs: [
    {
      slug: "ops",
      title: "Ops",
      hidden: false,
      createdBy: "user",
      widgets: [
        {
          id: "revenue-card",
          kind: "builtin:stat-card",
          title: "Revenue",
          grid: { x: 0, y: 0, w: 4, h: 2 },
          collapsed: false,
          hidden: false,
          createdBy: "user",
        },
      ],
    },
  ],
  widgetsRegistry: {},
  prefs: { tabOrder: ["ops"] },
};

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-integ-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

/** Register the REAL gateway handlers against `store` into a method map. */
function registerHandlers(store: WorkspaceStore, stateDir: string): RegisteredMethods {
  const methods: RegisteredMethods = new Map();
  const api = {
    registerGatewayMethod: (method: string, handler: Handler, opts: MethodOpts) => {
      methods.set(method, { handler, opts });
    },
  } as unknown as OpenClawPluginApi;
  registerWorkspaceGatewayMethods({ api, store, dataRead: { stateDir } });
  return methods;
}

/**
 * A real-routing GatewayBrowserClient stand-in: request(method, params) invokes
 * the matching registered handler with a captured `respond`, then resolves the
 * respond payload (ok) or throws its error (not-ok). NOT a canned value — real
 * client params drive the real handler.
 */
function createRoutingClient(methods: RegisteredMethods): RoutingClient {
  const request = async (method: string, params?: unknown): Promise<unknown> => {
    const entry = methods.get(method);
    if (!entry) {
      throw new Error(`gateway method not registered: ${method}`);
    }
    let captured:
      | { ok: boolean; payload?: unknown; error?: { code?: string; message?: string } }
      | undefined;
    const respond = (
      ok: boolean,
      payload?: unknown,
      error?: { code?: string; message?: string },
    ) => {
      captured = { ok, payload, error };
    };
    await entry.handler({
      params: params ?? {},
      respond,
      context: { broadcast: () => {} },
    } as never);
    if (!captured) {
      throw new Error(`gateway method did not respond: ${method}`);
    }
    if (!captured.ok) {
      const err = new Error(captured.error?.message ?? `gateway method failed: ${method}`);
      throw err;
    }
    return captured.payload;
  };
  return {
    request,
    addEventListener: () => () => {},
  } as unknown as RoutingClient;
}

function findWidget(doc: WorkspaceDoc, slug: string, id: string): WorkspaceWidget {
  const widget = doc.tabs.find((tab) => tab.slug === slug)?.widgets.find((w) => w.id === id);
  if (!widget) {
    throw new Error(`widget ${id} not found on tab ${slug}`);
  }
  return widget;
}

describe("workspace UI <-> gateway integration seam", () => {
  it("round-trips real UI client params through real handlers into the persisted store", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      store.replace(SEED_DOC, { actor: "user" });

      // Real data file for the file binding: a NESTED value behind a JSON pointer.
      const dataDir = path.join(stateDir, "workspaces", "data");
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(
        path.join(dataDir, "metrics.json"),
        JSON.stringify({ metrics: { revenue: 42 } }),
        "utf8",
      );

      const methods = registerHandlers(store, stateDir);
      const client = createRoutingClient(methods);
      const state = getWorkspaceState({});

      // --- get: the UI client consumes the real handler's response --------------
      await loadWorkspace(state, client);
      expect(state.loaded).toBe(true);
      expect(state.error).toBeNull();
      // Direct real-routing assertion on the get payload (independent of the UI's
      // defensive normalize): the seeded tab/widget survive the round-trip.
      const got = (await client.request("workspaces.get", {})) as { doc: WorkspaceDoc };
      expect(findWidget(got.doc, "ops", "revenue-card").title).toBe("Revenue");

      // --- (a) file binding: proves `{ binding }` + NO double pointer-apply -----
      // The client sends the WHOLE binding under `{ binding }`; the handler's
      // readParams whitelist accepts only `binding`, resolves the file AND applies
      // the JSON pointer server-side, returning `{ data: 42 }`. The UI must NOT
      // re-apply the pointer. If it did, applyPointer(42, "/metrics/revenue") would
      // be `undefined` — so asserting the resolved value is exactly 42 catches both
      // the pre-fix `{ path, pointer }` param shape (handler would reject it) and a
      // double-apply regression.
      const fileResult = await resolveBinding(client, {
        source: "file",
        path: "metrics.json",
        pointer: "/metrics/revenue",
      });
      expect(fileResult).toEqual({ value: 42 });

      // --- (b) mutations: each real client fn must land in the PERSISTED doc -----
      // Every assertion reads the store back from disk, so it proves the real
      // handler mutated real state (optimisticMutation swallows RPC errors into
      // state.actionError instead of throwing, so a wrong param shape would leave
      // the store unchanged — which these readbacks would catch).
      await setWidgetCollapsed(state, client, {
        slug: "ops",
        widgetId: "revenue-card",
        collapsed: true,
      });
      expect(findWidget(store.read(), "ops", "revenue-card").collapsed).toBe(true);

      await updateWidgetTitle(state, client, {
        slug: "ops",
        widgetId: "revenue-card",
        title: "Net Revenue",
      });
      expect(findWidget(store.read(), "ops", "revenue-card").title).toBe("Net Revenue");

      await moveWidget(state, client, {
        slug: "ops",
        widgetId: "revenue-card",
        grid: { x: 4, y: 1, w: 4, h: 3 },
      });
      expect(findWidget(store.read(), "ops", "revenue-card").grid).toEqual({
        x: 4,
        y: 1,
        w: 4,
        h: 3,
      });

      await removeWidgetFromTab(state, client, { slug: "ops", widgetId: "revenue-card" });
      const afterRemove = store.read();
      expect(afterRemove.tabs.find((tab) => tab.slug === "ops")?.widgets).toHaveLength(0);

      // No mutation surfaced an error through the whole round-trip.
      expect(state.actionError).toBeNull();
    });
  });

  it("catches the shipped contract drift: the pre-fix `{ slug, widgetId }` mutation shape is rejected and never mutates the store", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      store.replace(SEED_DOC, { actor: "user" });
      const methods = registerHandlers(store, stateDir);
      const client = createRoutingClient(methods);

      // The P1 bug sent the store's `{ slug, widgetId }` field names instead of the
      // gateway's `{ tab, id }`. The real handler's readParams whitelist
      // (tab, id, patch, actor) rejects `slug`/`widgetId` as unexpected params, so a
      // regressed client fails loudly here rather than shipping green.
      await expect(
        client.request("workspaces.widget.update", {
          slug: "ops",
          widgetId: "revenue-card",
          patch: { collapsed: true },
        }),
      ).rejects.toThrow(/unexpected param: slug/);

      // The rejected call left the persisted widget untouched.
      expect(findWidget(store.read(), "ops", "revenue-card").collapsed).toBe(false);
    });
  });
});
