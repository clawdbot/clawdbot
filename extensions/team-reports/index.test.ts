import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configRuntime from "./src/config.js";
import { createTeamReportsStore } from "./src/store.js";

vi.mock("./src/store.js", () => ({
  createTeamReportsStore: vi.fn(() => {
    throw new Error("Registration and retired startup must not open report storage");
  }),
}));

import plugin from "./index.js";

const pluginConfig = {
  basePath: "/team/activity/",
  github: { token: "fixture-github-token", orgs: ["sample"] },
  summaries: { enabled: false },
};
const config: OpenClawConfig = {
  gateway: { controlUi: { basePath: "/control" } },
  plugins: { entries: { "team-reports": { enabled: true, config: pluginConfig } } },
};

function captureReports() {
  const services: OpenClawPluginService[] = [];
  const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
  const methods: Array<Parameters<OpenClawPluginApi["registerGatewayMethod"]>> = [];
  const captured = capturePluginRegistration({
    id: plugin.id,
    name: plugin.name,
    config,
    register(api) {
      plugin.register({
        ...api,
        pluginConfig: api.config.plugins?.entries?.["team-reports"]?.config,
        registerService(service) {
          services.push(service);
          api.registerService(service);
        },
        registerHttpRoute(route) {
          routes.push(route);
          api.registerHttpRoute(route);
        },
        registerGatewayMethod(...args) {
          methods.push(args);
          api.registerGatewayMethod(...args);
        },
      });
    },
  });
  return { captured, services, routes, methods };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("Team Reports registration", () => {
  it("exposes reports through the authenticated tab, read methods, and admin generation method", () => {
    const { captured, services, routes, methods } = captureReports();
    expect(captured.controlUiDescriptors).toEqual([
      {
        surface: "tab",
        id: "team-reports",
        label: "Reports",
        description: "Team activity reports from GitHub and Discord.",
        icon: "chart",
        group: "control",
        requiredScopes: ["operator.read"],
        path: "/team/activity/",
      },
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/team/activity",
      match: "prefix",
      auth: "gateway",
      handler: expect.any(Function),
    });
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      id: "team-reports",
      reload: { configPrefixes: ["plugins.entries.team-reports"] },
      start: expect.any(Function),
      stop: expect.any(Function),
    });
    expect(methods.map(([name, , options]) => [name, options?.scope])).toEqual([
      ["team-reports.status", "operator.read"],
      ["team-reports.list", "operator.read"],
      ["team-reports.get", "operator.read"],
      ["team-reports.generate", "operator.admin"],
    ]);
    expect(captured.cliRegistrars).toMatchObject([
      {
        parentPath: [],
        commands: ["team-reports"],
        descriptors: [
          {
            name: "team-reports",
            description: "Read and generate team activity reports",
            hasSubcommands: true,
          },
        ],
      },
    ]);
    expect(createTeamReportsStore).not.toHaveBeenCalled();
  });

  it.each(["disable", "restart"] as const)(
    "does not revive storage or collection when credentials resolve after runtime %s",
    async (reason) => {
      const entered = createDeferred<void>();
      const credentials =
        createDeferred<Awaited<ReturnType<typeof configRuntime.resolveTeamReportsConfig>>>();
      vi.spyOn(configRuntime, "resolveTeamReportsConfig").mockImplementation(() => {
        entered.resolve();
        return credentials.promise;
      });
      const { captured, services } = captureReports();
      const service = services.find((entry) => entry.id === "team-reports");
      const lifecycle = captured.runtimeLifecycles.find(
        (entry) => entry.id === "team-reports-service",
      );
      if (!service || !lifecycle?.cleanup) {
        throw new Error("Team Reports must register its service and runtime cleanup");
      }
      const context: OpenClawPluginServiceContext = {
        config,
        stateDir: "/unused-team-reports-test-state",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };
      const starting = service.start(context);
      await entered.promise;
      await lifecycle.cleanup({ reason });
      const parsed = configRuntime.parseTeamReportsConfig(pluginConfig);
      credentials.resolve({
        github: {
          ...parsed.github,
          token: "fixture-github-token",
          ignoreCommentPatterns: [],
        },
        people: [],
      });
      await starting;
      expect(createTeamReportsStore).not.toHaveBeenCalled();
      await expect(service.start(context)).rejects.toThrow("runtime has been retired");
    },
  );
});
