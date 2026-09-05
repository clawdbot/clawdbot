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
  retiring: Set<BrokerSession>;
  current?: {
    params: BrokerParams;
    session: BrokerSession;
  };
};

function resolveBrokerOwner(): BrokerOwner {
  return resolveGlobalSingleton<BrokerOwner>(OPENAI_QUICKSILVER_SESSION_OWNER_KEY, () => ({
    retiring: new Set(),
  }));
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
  const mutableParams = {
    ...params,
    onCleanupComplete: () => {
      owner.retiring.delete(session);
    },
  };
  const session = createOpenAIQuicksilverBrowserSessionBroker(mutableParams);
  owner.current = { params: mutableParams, session };
  return session;
}

export async function releaseOpenAIQuicksilverBrowserSessionBroker(
  session: BrokerSession,
): Promise<void> {
  const owner = resolveBrokerOwner();
  // A replacement may admit new work, but failed old cleanup retains its exact
  // capability and global reservation until background or explicit retry succeeds.
  if (owner.current?.session === session) {
    owner.current = undefined;
    owner.retiring.add(session);
  }
  // Even a completed replacement's cleanup callback must retry retained older
  // generations. Do not re-add empty owners or touch a different live current.
  const results = await Promise.allSettled(
    Array.from(owner.retiring, (retiring) => retiring.cleanup()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "OpenAI realtime broker cleanup remains incomplete");
  }
}
