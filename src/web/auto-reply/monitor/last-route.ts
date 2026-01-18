import type { MsgContext } from "../../../auto-reply/templating.js";
import type { loadConfig } from "../../../config/config.js";
import { resolveStorePath, updateLastRoute } from "../../../config/sessions.js";
import { formatError } from "../../session.js";

export function trackBackgroundTask(
  backgroundTasks: Set<Promise<unknown>>,
  task: Promise<unknown>,
) {
  backgroundTasks.add(task);
  void task.finally(() => {
    backgroundTasks.delete(task);
  });
}

export function updateLastRouteInBackground(params: {
  cfg: ReturnType<typeof loadConfig>;
  backgroundTasks: Set<Promise<unknown>>;
  storeAgentId: string;
  sessionKey: string;
  channel: "whatsapp";
  to: string;
  accountId?: string;
  ctx?: MsgContext;
  warn: (obj: unknown, msg: string) => void;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.storeAgentId,
  });
  const task = updateLastRoute({
    storePath,
    sessionKey: params.sessionKey,
    deliveryContext: {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
    },
    ctx: params.ctx,
  }).catch((err) => {
    params.warn(
      {
        error: formatError(err),
        storePath,
        sessionKey: params.sessionKey,
        to: params.to,
      },
      "failed updating last route",
    );
  });
  trackBackgroundTask(params.backgroundTasks, task);
}

export function awaitBackgroundTasks(backgroundTasks: Set<Promise<unknown>>) {
  if (backgroundTasks.size === 0) return Promise.resolve();
  return Promise.allSettled(backgroundTasks).then(() => {
    backgroundTasks.clear();
  });
}
