/** Controller-authorized subagent list, kill, steer, and message operations. */
import { setSubagentKillTestDeps } from "./subagent-control-kill-runtime.js";
import { setSubagentMessagingTestDeps } from "./subagent-control-messaging.js";

export {
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  killSubagentRunAdmin,
} from "./subagent-control-kill.js";
export {
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "./subagent-control-messaging.js";
export {
  buildControlledSubagentRunsReadContext,
  DEFAULT_RECENT_MINUTES,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
  type ResolvedSubagentController,
} from "./subagent-control-scope.js";

type SubagentKillTestDeps = NonNullable<Parameters<typeof setSubagentKillTestDeps>[0]>;
type SubagentMessagingTestDeps = NonNullable<Parameters<typeof setSubagentMessagingTestDeps>[0]>;

const testing = {
  setDepsForTest(overrides?: SubagentKillTestDeps & SubagentMessagingTestDeps) {
    setSubagentKillTestDeps(overrides);
    setSubagentMessagingTestDeps(overrides);
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentControlTestApi")] =
    testing;
}
