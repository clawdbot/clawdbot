// Runtime system helpers expose host system operations to activated plugin runtimes.
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEventRaw as enqueueSystemEventInternal } from "../../infra/system-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import type { RunHeartbeatOnceOptions } from "./types-core.js";
import type { PluginRuntime } from "./types.js";

const loadHeartbeatRunnerRuntime = createLazyRuntimeModule(
  () => import("../../infra/heartbeat-runner.js"),
);
const runHeartbeatOnceInternal = createLazyRuntimeMethod(
  loadHeartbeatRunnerRuntime,
  (runtime) => runtime.runHeartbeatOnce,
);

// Plugin-provided system events are untrusted by construction: force `trusted: false`
// so prompt assembly keeps plugin content in the external-content role. Trusted-internal
// producers (continuation/post-compaction) enqueue via the direct `infra/system-events`
// import, not this plugin runtime facade.
//
// Also strip the session-delivery ack fields (`sessionDeliveryAckId` /
// `sessionDeliveryAckStateDir`): on drain they trigger a blind
// `deleteDeliveryQueueEntry` at the caller-supplied state dir, so a plugin must
// never inject them through this facade. The legitimate ack producer
// (continuation-return) sets them via the direct `infra/system-events` import.
const enqueueSystemEvent: PluginRuntime["system"]["enqueueSystemEvent"] = (text, options) => {
  const {
    sessionDeliveryAckId: _ackId,
    sessionDeliveryAckStateDir: _ackStateDir,
    ...rest
  } = options ?? {};
  return enqueueSystemEventInternal(text, { ...rest, trusted: false });
};

/** Creates the plugin runtime system facade with heartbeat/event/process helpers. */
export function createRuntimeSystem(): PluginRuntime["system"] {
  const requestHeartbeatNow: PluginRuntime["system"]["requestHeartbeatNow"] = (opts) =>
    requestHeartbeat({
      source: opts?.source ?? "other",
      intent: opts?.intent ?? "immediate",
      reason: opts?.reason,
      coalesceMs: opts?.coalesceMs,
      agentId: opts?.agentId,
      sessionKey: opts?.sessionKey,
      heartbeat: opts?.heartbeat,
    });

  return {
    enqueueSystemEvent,
    requestHeartbeat,
    requestHeartbeatNow,
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => {
      // Destructure to forward only the plugin-safe subset; prevent cfg/deps injection at runtime.
      const { reason, agentId, sessionKey, heartbeat } = opts ?? {};
      return runHeartbeatOnceInternal({
        reason,
        agentId,
        sessionKey,
        heartbeat: heartbeat ? { target: heartbeat.target } : undefined,
      });
    },
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}
