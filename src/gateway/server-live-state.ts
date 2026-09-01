import type { TaskLanesConfig } from "../config/types.task-lanes.js";
// Gateway live state factory.
// Combines mutable runtime handles with startup-resolved services for request contexts.
import type { PluginServicesHandle } from "../plugins/services.js";
import { registerConfiguredTaskLaneProviders } from "../task-lanes/gateway/config-registration.js";
import {
  createTaskLaneGatewayService,
  type TaskLaneGatewayService,
} from "../task-lanes/gateway/service.js";
import type { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  createGatewayServerMutableState,
  type GatewayServerMutableState,
} from "./server-runtime-handles.js";
import type { HookClientIpConfig } from "./server/hooks-request-handler.js";
import type { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

/** Mutable gateway server state shared across request contexts. */
export type GatewayServerLiveState = GatewayServerMutableState & {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  taskLanes: TaskLaneGatewayService;
  controlUiSessionPullRequests?: ReturnType<typeof createControlUiSessionPullRequestSubscriptions>;
  sessionViewerPresence?: ReturnType<typeof createSessionViewerPresenceDeclarations>;
  pluginServices: PluginServicesHandle | null;
  gatewayMethods: string[];
};

/** Creates gateway live state with fresh mutable runtime handles. */
export function createGatewayServerLiveState(params: {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  gatewayMethods: string[];
  taskLanesConfig?: TaskLanesConfig;
}): GatewayServerLiveState {
  const taskLanes = createTaskLaneGatewayService();
  registerConfiguredTaskLaneProviders(taskLanes, params.taskLanesConfig);
  return {
    ...createGatewayServerMutableState(),
    hooksConfig: params.hooksConfig,
    hookClientIpConfig: params.hookClientIpConfig,
    cronState: params.cronState,
    taskLanes,
    controlUiSessionPullRequests: undefined,
    sessionViewerPresence: undefined,
    pluginServices: null,
    gatewayMethods: params.gatewayMethods,
  };
}
