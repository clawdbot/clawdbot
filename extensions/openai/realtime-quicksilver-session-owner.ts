import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { createOpenAIQuicksilverBrowserSessionBroker } from "./realtime-quicksilver-session.js";

const OPENAI_QUICKSILVER_SESSION_OWNER_KEY = Symbol.for(
  "openclaw.openai.quicksilverBrowserSessionOwner.v1",
);

type BrokerSession = ReturnType<typeof createOpenAIQuicksilverBrowserSessionBroker>;

type BrokerParams = {
  getConfig: () => OpenClawConfig | undefined;
  logger: Pick<PluginLogger, "debug" | "warn">;
};

type BrokerOwner = {
  current?: {
    params: BrokerParams;
    session: BrokerSession;
  };
};

function resolveBrokerOwner(): BrokerOwner {
  return resolveGlobalSingleton<BrokerOwner>(OPENAI_QUICKSILVER_SESSION_OWNER_KEY, () => ({}));
}

export function acquireOpenAIQuicksilverBrowserSessionBroker(params: BrokerParams): BrokerSession {
  const owner = resolveBrokerOwner();
  if (owner.current) {
    owner.current.params.getConfig = params.getConfig;
    owner.current.params.logger = params.logger;
    return owner.current.session;
  }

  // Full plugin registration can run more than once in one process. The provider and
  // HTTP route must share one reservation map or an offer reserved by one rejects at another.
  const mutableParams = { ...params };
  const session = createOpenAIQuicksilverBrowserSessionBroker(mutableParams);
  owner.current = { params: mutableParams, session };
  return session;
}

export async function releaseOpenAIQuicksilverBrowserSessionBroker(
  session: BrokerSession,
): Promise<void> {
  const owner = resolveBrokerOwner();
  if (owner.current?.session !== session) {
    return;
  }

  // Release ownership before async teardown so a later registration can install a replacement.
  owner.current = undefined;
  await session.cleanup();
}
