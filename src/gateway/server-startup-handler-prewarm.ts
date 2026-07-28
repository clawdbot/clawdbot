import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";

type StartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

type GatewayHandlerPrewarmFamily = {
  name: string;
  load: () => Promise<unknown>;
};

type GatewayHandlerPrewarmHandle = {
  stop: () => void;
};

// These are the families requested by the Control UI's first dashboard turn.
// Keep the list explicit so adding a cold import is a conscious startup tradeoff.
const DASHBOARD_HANDLER_FAMILIES: readonly GatewayHandlerPrewarmFamily[] = [
  { name: "sessions", load: () => import("./server-methods/sessions.js") },
  { name: "chat", load: () => import("./server-methods/chat.js") },
  { name: "tasks", load: () => import("./server-methods/tasks.js") },
  { name: "cron", load: () => import("./server-methods/cron.js") },
  { name: "models-auth-status", load: () => import("./server-methods/models-auth-status.js") },
  { name: "agent-identity", load: () => import("./server-methods/agent-identity.js") },
  { name: "board", load: () => import("./server-methods/board.js") },
  { name: "channels", load: () => import("./server-methods/channels.js") },
];

export function scheduleGatewayHandlerPrewarm(params: {
  startupTrace?: StartupTrace;
  log: { warn: (msg: string) => void };
  families?: readonly GatewayHandlerPrewarmFamily[];
}): GatewayHandlerPrewarmHandle {
  const families = params.families ?? DASHBOARD_HANDLER_FAMILIES;
  let stopped = false;
  let nextIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = () => {
    if (stopped || nextIndex >= families.length) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) {
        return;
      }
      const family = families[nextIndex++];
      if (!family) {
        return;
      }
      const load = () => family.load();
      void runWithGatewayIndependentRootWorkAdmission(() =>
        params.startupTrace
          ? params.startupTrace.measure(`post-ready.gateway-handler.${family.name}`, load)
          : load(),
      )
        .catch((err: unknown) => {
          params.log.warn(
            `post-ready gateway handler prewarm failed for ${family.name}: ${String(err)}`,
          );
        })
        .finally(scheduleNext);
    }, 0);
    timer.unref?.();
  };

  // One family per event-loop turn keeps this work behind readiness and lets
  // immediate client traffic run between imports instead of recreating a startup wall.
  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
