import type { ManagedRun } from "../process/supervisor/index.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { createDeferred } from "../shared/deferred.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

type SupervisorSpawnMock = {
  mockImplementationOnce: (implementation: (input: SpawnInput) => Promise<ManagedRun>) => unknown;
};

export async function startDeferredNotifyRun(params: {
  spawn: SupervisorSpawnMock;
  sessionKey: string;
  notifyDeliveryContext?: DeliveryContext;
}) {
  const exit = createDeferred<Awaited<ReturnType<ManagedRun["wait"]>>>();
  params.spawn.mockImplementationOnce(async (input) => {
    input.onStdout?.("producer output\n");
    return {
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
    notifyDeliveryContext: params.notifyDeliveryContext,
    timeoutSec: null,
  });
  markBackgrounded(run.session);
  return {
    run,
    finish: async () => {
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
