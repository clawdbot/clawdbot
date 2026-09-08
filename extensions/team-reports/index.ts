import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseTeamReportsConfig, resolveTeamReportsConfig } from "./src/config.js";
import { registerTeamReportsGatewayMethods } from "./src/gateway-methods.js";
import { createTeamReportsHttpHandler } from "./src/http.js";
import { TeamReportsScheduler } from "./src/scheduler.js";
import { createTeamReportsStore, type TeamReportsStore } from "./src/store.js";

export default definePluginEntry({
  id: "team-reports",
  name: "Team Reports",
  description:
    "Daily, weekly, and monthly team activity reports from GitHub and Discord, with model-written summaries.",
  configSchema: { parse: parseTeamReportsConfig },
  register(api) {
    const initial = parseTeamReportsConfig(
      api.pluginConfig,
      api.config.gateway?.controlUi?.basePath,
    );
    let scheduler: TeamReportsScheduler | undefined;
    let store: TeamReportsStore | undefined;
    let generation = 0;
    let retired = false;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      generation++;
      const current = scheduler;
      scheduler = undefined;
      const currentStore = store;
      store = undefined;
      return (stopping ??= (async () => {
        try {
          await current?.stop();
        } finally {
          currentStore?.close();
        }
      })());
    };
    const requireScheduler = () => {
      if (!scheduler) {
        throw new Error(
          "Team Reports service is not running; check plugin configuration and restart the Gateway",
        );
      }
      return scheduler;
    };
    const requireStore = () => {
      if (!store) {
        throw new Error("Team Reports storage is unavailable; check service status");
      }
      return store;
    };

    api.registerService({
      id: "team-reports",
      reload: { configPrefixes: ["plugins.entries.team-reports"] },
      async start(ctx) {
        if (retired) {
          throw new Error("Team Reports runtime has been retired");
        }
        const currentGeneration = ++generation;
        await stopping;
        if (retired || currentGeneration !== generation) {
          return;
        }
        stopping = undefined;
        const config = parseTeamReportsConfig(
          ctx.config.plugins?.entries?.["team-reports"]?.config ?? api.pluginConfig,
          ctx.config.gateway?.controlUi?.basePath,
        );
        const resolved = await resolveTeamReportsConfig(config, ctx.config);
        if (retired || currentGeneration !== generation) {
          return;
        }
        const policy = ctx.config.plugins?.entries?.["team-reports"]?.llm;
        const summaryOptions = { ...config.summaries };
        if (policy?.allowModelOverride !== true) {
          delete summaryOptions.model;
        }
        store = createTeamReportsStore({ stateDir: ctx.stateDir });
        scheduler = new TeamReportsScheduler({
          config: { ...config, summaries: summaryOptions },
          resolved,
          store,
          llm: api.runtime.llm,
          context: ctx,
        });
        scheduler.start();
      },
      stop,
    });
    api.lifecycle.registerRuntimeLifecycle({
      id: "team-reports-service",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (
          sessionKey === undefined &&
          runId === undefined &&
          (reason === "disable" || reason === "restart")
        ) {
          retired = true;
          return stop();
        }
        return undefined;
      },
    });
    // Route and descriptor registration belong to the registry, not a restarted service.
    api.registerReload({
      restartPrefixes: [
        "plugins.entries.team-reports.config.basePath",
        "plugins.entries.team-reports.config.displayTimezone",
      ],
    });
    api.registerHttpRoute({
      path: initial.basePath,
      match: "prefix",
      auth: "gateway",
      handler: createTeamReportsHttpHandler({
        basePath: initial.basePath,
        displayTimezone: initial.displayTimezone,
        // Source checkouts, the flattened dist bundle, and installed packages all keep assets/ at the plugin root.
        assetsDir: path.join(api.rootDir ?? path.dirname(fileURLToPath(import.meta.url)), "assets"),
        getStore: () => store,
        status: () => requireScheduler().status(),
        health: () => requireScheduler().health(),
        orgs: () => scheduler?.orgs() ?? initial.github.orgs,
        people: () => scheduler?.people() ?? initial.people ?? [],
      }),
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "team-reports",
      label: "Reports",
      description: "Team activity reports from GitHub and Discord.",
      icon: "chart",
      group: "control",
      requiredScopes: ["operator.read"],
      path: `${initial.basePath}/`,
    });
    registerTeamReportsGatewayMethods(api, { scheduler: requireScheduler, store: requireStore });
    api.registerCli(
      async ({ program }) => {
        const { registerTeamReportsCli } = await import("./src/cli.js");
        registerTeamReportsCli({ program });
      },
      {
        descriptors: [
          {
            name: "team-reports",
            description: "Read and generate team activity reports",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
