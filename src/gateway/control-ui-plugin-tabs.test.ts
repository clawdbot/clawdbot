import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import {
  pinActivePluginSessionExtensionRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  listControlUiPluginTabAuthGrants,
  listControlUiPluginTabs,
  listControlUiPluginWidgetKinds,
} from "./control-ui-plugin-tabs.js";

function tabDescriptor(
  overrides: Partial<PluginControlUiDescriptor> = {},
): PluginControlUiDescriptor {
  return {
    id: "logbook",
    surface: "tab",
    label: "Logbook",
    ...overrides,
  };
}

function activateDescriptors(
  entries: Array<{ pluginId: string; descriptor: PluginControlUiDescriptor }>,
  routes: Array<{
    pluginId: string;
    path: string;
    auth?: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }> = [],
): void {
  const registry = createTestRegistry([]);
  registry.controlUiDescriptors = entries.map((entry) => ({
    ...entry,
    source: `test:${entry.pluginId}`,
  }));
  registry.httpRoutes = routes.map((route) => ({
    ...route,
    auth: route.auth ?? "gateway",
    match: route.match ?? "prefix",
    source: `test:${route.pluginId}`,
    handler: async () => true,
  }));
  setActivePluginRegistry(registry);
}

describe("listControlUiPluginTabs", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("projects only tab descriptors", () => {
    activateDescriptors([
      { pluginId: "logbook", descriptor: tabDescriptor() },
      { pluginId: "other", descriptor: tabDescriptor({ id: "run-panel", surface: "run" }) },
    ]);

    const tabs = listControlUiPluginTabs(["operator.admin"]);
    expect(tabs.map((tab) => tab.id)).toEqual(["logbook"]);
    expect(expectDefined(tabs[0], "tabs[0] test invariant").pluginId).toBe("logbook");
  });

  it("hides tabs whose required scopes are not granted", () => {
    activateDescriptors([
      {
        pluginId: "logbook",
        descriptor: tabDescriptor({ requiredScopes: ["operator.write"] }),
      },
      {
        pluginId: "adminy",
        descriptor: tabDescriptor({
          id: "adminy",
          label: "Admin",
          requiredScopes: ["operator.admin"],
        }),
      },
    ]);

    expect(listControlUiPluginTabs(["operator.read"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.write"]).map((tab) => tab.id)).toEqual(["logbook"]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.id)).toEqual([
      "adminy",
      "logbook",
    ]);
  });

  it("orders deterministically by order, label, then id", () => {
    activateDescriptors([
      { pluginId: "b", descriptor: tabDescriptor({ id: "beta", label: "Beta" }) },
      { pluginId: "a", descriptor: tabDescriptor({ id: "alpha", label: "Alpha", order: 5 }) },
      { pluginId: "c", descriptor: tabDescriptor({ id: "zed", label: "Beta" }) },
    ]);

    expect(listControlUiPluginTabs([]).map((tab) => tab.id)).toEqual(["beta", "zed", "alpha"]);
  });

  it("projects scoped widget descriptors as namespaced kinds", () => {
    activateDescriptors([
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "card",
          surface: "widget",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        }),
      },
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "mini",
          surface: "widget",
          label: "Workboard summary",
          requiredScopes: ["operator.read"],
        }),
      },
    ]);

    expect(listControlUiPluginWidgetKinds([])).toEqual([]);
    expect(listControlUiPluginWidgetKinds(["operator.read"])).toEqual([
      { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
      { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
    ]);
  });

  it("survives agent-turn active-registry swaps via the pinned session-extension registry", () => {
    const gatewayRegistry = createTestRegistry([]);
    gatewayRegistry.controlUiDescriptors = [
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "card",
          surface: "widget",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        }),
        source: "test:workboard",
      },
      { pluginId: "logbook", descriptor: tabDescriptor(), source: "test:logbook" },
    ];
    // Gateway startup pins its fully wired registry on the session-extension surface.
    pinActivePluginSessionExtensionRegistry(gatewayRegistry);

    // Agent-turn standalone loads install a registry without control-UI descriptors.
    setActivePluginRegistry(createTestRegistry([]));

    expect(listControlUiPluginWidgetKinds(["operator.read"]).map((kind) => kind.kind)).toEqual([
      "workboard:card",
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.id)).toEqual(["logbook"]);
  });

  it("grants only same-plugin gateway routes with least-privilege scopes", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ path: "/plugins/logbook/panel" }),
        },
        {
          pluginId: "adminy",
          descriptor: tabDescriptor({
            id: "adminy",
            path: "/plugins/adminy/panel",
            requiredScopes: ["operator.admin"],
          }),
        },
        {
          pluginId: "publicish",
          descriptor: tabDescriptor({ id: "publicish", path: "/plugins/publicish/panel" }),
        },
      ],
      [
        { pluginId: "logbook", path: "/plugins/logbook", match: "prefix" },
        { pluginId: "adminy", path: "/plugins/adminy", match: "prefix" },
        {
          pluginId: "publicish",
          path: "/plugins/publicish",
          auth: "plugin",
          match: "prefix",
        },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "adminy",
        path: "/plugins/adminy",
        match: "prefix",
        scopes: ["operator.read"],
      },
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    const adminTabs = listControlUiPluginTabs(["operator.admin"]);
    expect(adminTabs).toEqual([
      expect.objectContaining({
        pluginId: "adminy",
        requiresGatewayAuth: true,
      }),
      expect.objectContaining({
        pluginId: "logbook",
        requiresGatewayAuth: true,
      }),
      expect.objectContaining({
        pluginId: "publicish",
      }),
    ]);
    expect(adminTabs[2]).not.toHaveProperty("requiresGatewayAuth");
    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("matches gateway routes against descriptor URL pathnames", () => {
    const path = "/plugins/logbook/panel?view=activity#settings";
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path }) }],
      [{ pluginId: "logbook", path: "/plugins/logbook/panel", match: "exact" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook/panel",
        match: "exact",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.read"])).toEqual([
      expect.objectContaining({ path, requiresGatewayAuth: true }),
    ]);
  });

  it("does not grant a matching route owned by another plugin", () => {
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path: "/shared/panel" }) }],
      [{ pluginId: "other", path: "/shared", match: "prefix" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
  });

  it("uses the first dispatched gateway route as descriptor owner", () => {
    activateDescriptors(
      [{ pluginId: "outer", descriptor: tabDescriptor({ path: "/shared/panel" }) }],
      [
        { pluginId: "nested", path: "/shared/panel", match: "exact" },
        { pluginId: "outer", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
  });

  it("does not require a cookie grant when gateway auth is disabled", () => {
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path: "/plugins/logbook/panel" }) }],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    const [tab] = listControlUiPluginTabs(["operator.admin"], {
      requireGatewayAuthGrant: false,
    });
    expect(tab).toMatchObject({ pluginId: "logbook" });
    expect(tab).not.toHaveProperty("requiresGatewayAuth");
  });

  it("coalesces same-plugin tabs that share one read-only cookie path", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ path: "/plugins/logbook/read" }),
        },
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({
            id: "admin",
            path: "/plugins/logbook/admin",
            requiredScopes: ["operator.admin"],
          }),
        },
      ],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("widens a shared exact cookie path when another visible tab needs prefix matching", () => {
    activateDescriptors(
      [
        { pluginId: "logbook", descriptor: tabDescriptor({ path: "/plugins/logbook" }) },
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ id: "child", path: "/plugins/logbook/child" }),
        },
      ],
      [
        { pluginId: "logbook", path: "/plugins/logbook", match: "exact" },
        { pluginId: "logbook", path: "/plugins/logbook", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("keeps separate grants for different plugins that share a cookie path", () => {
    activateDescriptors(
      [
        { pluginId: "alpha", descriptor: tabDescriptor({ id: "alpha", path: "/shared" }) },
        {
          pluginId: "beta",
          descriptor: tabDescriptor({ id: "beta", path: "/shared/child" }),
        },
      ],
      [
        { pluginId: "alpha", path: "/shared", match: "exact" },
        { pluginId: "beta", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "alpha",
        path: "/shared",
        match: "exact",
        scopes: ["operator.read"],
      },
      {
        pluginId: "beta",
        path: "/shared",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.pluginId)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("uses only the first route owner when plugins declare the same path", () => {
    activateDescriptors(
      [
        { pluginId: "alpha", descriptor: tabDescriptor({ id: "alpha", path: "/shared" }) },
        { pluginId: "beta", descriptor: tabDescriptor({ id: "beta", path: "/shared" }) },
      ],
      [
        { pluginId: "alpha", path: "/shared", match: "exact" },
        { pluginId: "beta", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "alpha",
        path: "/shared",
        match: "exact",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.pluginId)).toEqual([
      "alpha",
    ]);
  });
});
