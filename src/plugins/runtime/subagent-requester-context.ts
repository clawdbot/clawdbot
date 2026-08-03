import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";

export type PluginSubagentRequesterContext = Readonly<{
  sessionKey: string;
  origin: Readonly<DeliveryContext>;
}>;

type PluginSubagentRequesterScope = {
  active: boolean;
  requester: PluginSubagentRequesterContext;
};

const PLUGIN_SUBAGENT_REQUESTER_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginSubagentRequesterScope",
);

const pluginSubagentRequesterScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginSubagentRequesterScope>
>(PLUGIN_SUBAGENT_REQUESTER_SCOPE_KEY, () => new AsyncLocalStorage<PluginSubagentRequesterScope>());

export function createPluginSubagentRequesterContext(params: {
  sessionKey?: string;
  origin?: DeliveryContext;
}): PluginSubagentRequesterContext | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const origin = normalizeDeliveryContext(params.origin);
  if (!sessionKey || !origin?.channel || !origin.to) {
    return undefined;
  }
  return Object.freeze({
    sessionKey,
    origin: Object.freeze({ ...origin }),
  });
}

export async function withPluginSubagentRequesterContext<T>(
  requester: PluginSubagentRequesterContext,
  run: () => Promise<T>,
): Promise<T> {
  const scope: PluginSubagentRequesterScope = { active: true, requester };
  return await pluginSubagentRequesterScope.run(scope, async () => {
    try {
      return await run();
    } finally {
      // Detached hook work must not retain requester authority after the invocation ends.
      scope.active = false;
    }
  });
}

function getPluginSubagentRequesterContext(): PluginSubagentRequesterContext | undefined {
  const scope = pluginSubagentRequesterScope.getStore();
  return scope?.active === true ? scope.requester : undefined;
}

export function resolvePluginSubagentCompletionRequester(
  completionDelivery: unknown,
): PluginSubagentRequesterContext | undefined {
  if (completionDelivery !== undefined && completionDelivery !== "current-requester") {
    throw new Error("Unsupported plugin subagent completionDelivery value.");
  }
  if (completionDelivery === undefined) {
    return undefined;
  }
  const requester = getPluginSubagentRequesterContext();
  if (!requester) {
    throw new Error(
      'completionDelivery "current-requester" requires an active requester-bound plugin hook invocation.',
    );
  }
  return requester;
}
