import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  buildNativeHookRelayCommandWithStateDatabase,
  resolveNativeHookRelayCommandTimeoutMs,
} from "./native-hook-relay-command.js";
import {
  nativeHookRelayEventHasLocalWork,
  nativeHookRelayEventToolMatcher,
} from "./native-hook-relay-events.js";
import {
  NATIVE_HOOK_RELAY_EVENTS,
  type NativeHookRelayRegistrationHandle,
  type RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";

export type NativeHookRelayCommandPlan = Pick<
  NativeHookRelayRegistrationHandle,
  "shouldRelayEvent" | "toolMatcherForEvent" | "commandForEvent"
>;

/** Snapshot static policy and commands without registering a bridge, TTL, or live callbacks. */
export function buildNativeHookRelayCommandPlan(
  params: Pick<
    RegisterNativeHookRelayParams,
    "provider" | "agentId" | "sessionKey" | "config" | "preToolUseLoopDetection" | "command"
  > & { relayId: string; generation: string },
): NativeHookRelayCommandPlan {
  const stateDbPath = resolveOpenClawStateSqlitePath();
  const policy = { ...params, preToolUseLoopDetection: params.preToolUseLoopDetection !== false };
  const facts = new Map(
    NATIVE_HOOK_RELAY_EVENTS.map((event) => [
      event,
      {
        enabled: nativeHookRelayEventHasLocalWork(policy, event),
        matcher: nativeHookRelayEventToolMatcher(policy, event)?.slice(),
      },
    ]),
  );
  return {
    shouldRelayEvent: (event) => facts.get(event)?.enabled === true,
    toolMatcherForEvent: (event) => facts.get(event)?.matcher?.slice(),
    commandForEvent: (event, options) =>
      buildNativeHookRelayCommandWithStateDatabase({
        provider: params.provider,
        relayId: params.relayId,
        generation: params.generation,
        stateDbPath,
        event,
        nice: params.command?.nice,
        timeoutMs: resolveNativeHookRelayCommandTimeoutMs(
          params.command?.timeoutMs,
          options?.timeoutMs,
        ),
        executable: params.command?.executable,
        nodeExecutable: params.command?.nodeExecutable,
      }),
  };
}
