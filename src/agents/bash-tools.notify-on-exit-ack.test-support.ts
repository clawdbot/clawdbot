import type { ManagedRun } from "../process/supervisor/index.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

type SupervisorSpawnMock = {
  mockImplementationOnce: (implementation: (input: SpawnInput) => Promise<ManagedRun>) => unknown;
};

export async function startDeferredNotifyRun(params: {
  spawn: SupervisorSpawnMock;
  sessionKey: string;
  agentId?: string;
  notifyDeliveryContext?: DeliveryContext;
}) {
  const exit = createDeferredCore<Awaited<ReturnType<ManagedRun["wait"]>>>();
  const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
  params.spawn.mockImplementationOnce(async (input) => {
    input.onStdout?.("producer output\n");
    return {
      activity,
      runId: input.runId ?? "notify-on-exit",
      startedAtMs: Date.now(),
      wait: async () => await exit.promise,
      cancel: () => undefined,
    };
  });
  const run = await runExecProcess({
    command: "notify-command",
    workdir: process.cwd(),
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: true,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    notifyDeliveryContext: params.notifyDeliveryContext,
    timeoutSec: null,
  });
  markBackgrounded(run.session);
  return {
    run,
    finish: async () => {
      activity.resultSettled = true;
      exit.resolve({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
      await run.promise;
    },
  };
}
