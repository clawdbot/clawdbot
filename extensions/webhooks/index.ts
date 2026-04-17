import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { resolveWebhooksPluginConfig } from "./src/config.js";
import { createTaskFlowWebhookRequestHandler, type TaskFlowWebhookTarget } from "./src/http.js";

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const routes = resolveWebhooksPluginConfig({
    pluginConfig: api.pluginConfig,
  });
  if (routes.length === 0) {
    return;
  }

  const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>();
  const handler = createTaskFlowWebhookRequestHandler({
    cfg: api.config,
    targetsByPath,
  });

  for (const route of routes) {
    const taskFlow = api.runtime.taskFlow.bindSession({
      sessionKey: route.sessionKey,
    });
    const target: TaskFlowWebhookTarget = {
      routeId: route.routeId,
      path: route.path,
      secretInput: route.secret,
      secretConfigPath: `plugins.entries.webhooks.routes.${route.routeId}.secret`,
      defaultControllerId: route.controllerId,
      taskFlow,
    };
    targetsByPath.set(target.path, [...(targetsByPath.get(target.path) ?? []), target]);
    api.registerHttpRoute({
      path: target.path,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler,
    });
    api.logger.info?.(
      `[webhooks] registered route ${route.routeId} on ${route.path} for session ${route.sessionKey}`,
    );
  }
}

export default definePluginEntry({
  id: "webhooks",
  name: "Webhooks",
  description:
    "Authenticated inbound webhooks that bind external automation to OpenClaw TaskFlows.",
  register(api: OpenClawPluginApi) {
    registerWebhookRoutes(api);
  },
});
