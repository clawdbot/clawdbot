import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { resolveGatewayService } from "../../daemon/service.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import {
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeObservation,
  type UpdateRecoveryNativeFacts,
  type UpdateRecoveryNativeAction,
} from "../../infra/update-run-recovery-native.js";
import { assertExactUpdateRecoveryClaim } from "../../infra/update-run-recovery.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import { setUpdateCommandNativePolicy } from "./update-command-native-policy.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Restore the captured native policy and start under the original source and
 * executor owners. Readiness/terminal completion stays inside this live interval.
 * A native readback is not a serving receipt and never completes the generic restart.
 */
export async function withUpdateCommandNativeRestoration<T>(
  params: {
    recovery: UpdateCommandRecovery;
    env: NodeJS.ProcessEnv;
    runtime: "candidate" | "previous";
    timeoutMs?: number;
    stdout: NodeJS.WritableStream;
  },
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const { recovery, env, runtime } = params;
  const initial = recovery.getRecord();
  const manager = initial.nativeManager;
  if (
    !initial.checkpoint ||
    !manager ||
    manager.identity.platform !== platform() ||
    !manager.original.exists ||
    !manager.original.loaded ||
    manager.original.stopped ||
    (runtime === "candidate"
      ? initial.primaryFailure !== null
      : !initial.primaryFailure || initial.restore?.phase !== "observed")
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Native restoration requires the captured running service and reconciled runtime.",
    );
  }
  return await withUpdateCommandSourceOwnership(
    {
      recovery,
      env,
      mutation: true,
      ...(runtime === "previous" ? { restored: true as const } : {}),
    },
    async (source) => {
      const { assertCurrent, verifySources, definitionPaths } = source;
      const fence = { assertCurrent };
      const observe = () =>
        readUpdateCommandNativeObservation({
          record: recovery.getRecord(),
          env,
          definitionPaths,
          assertCurrent,
          timeoutMs: params.timeoutMs,
        });
      const apply = async (
        target: UpdateRecoveryNativeFacts,
        restart: boolean,
        effect: () => Promise<void>,
        action: UpdateRecoveryNativeAction = "restore",
      ) => {
        const current = recovery.getRecord();
        assertExactUpdateRecoveryClaim(current, fence, recovery.options);
        await verifySources();
        const prior = current.nativeManager!.effects.at(-1);
        const pendingRestart = current.effects.at(-1);
        const reuse =
          prior?.action === action &&
          isDeepStrictEqual(prior.after, target) &&
          (prior.state === "intent" ||
            (restart &&
              pendingRestart?.kind === "service-restart" &&
              pendingRestart.effectId === prior.effectId));
        const intent = await recordUpdateRecoveryNativeIntent(
          current,
          {
            effectId: reuse && prior ? prior.effectId : randomUUID(),
            action,
            target,
            observe,
            ...(restart ? { restart: { runtime, resourceId: "gateway" } } : {}),
          },
          fence,
          recovery.options,
        );
        recovery.onRecord(intent.record);
        let failure: { error: unknown } | undefined;
        if (intent.status === "before") {
          try {
            assertCurrent();
            await effect();
          } catch (error) {
            failure = { error };
          }
        }
        assertCurrent();
        await verifySources();
        const observed = await recordUpdateRecoveryNativeObservation(
          intent.record,
          intent.record.nativeManager!.effects.at(-1)!.effectId,
          observe,
          fence,
          recovery.options,
        );
        recovery.onRecord(observed.record);
        if (failure || observed.status !== "after") {
          throw new UpdateCommandRecoveryPendingError(
            "Native restoration remains pending independent readback.",
            { cause: failure?.error },
          );
        }
      };
      const native = recovery.getRecord().nativeManager!;
      const setPolicy = async (enabled: boolean) => {
        const latest = recovery.getRecord().nativeManager!.effects.at(-1);
        const before =
          latest?.state === "intent"
            ? latest.before
            : currentUpdateRecoveryNativeFacts(recovery.getRecord().nativeManager!);
        const target = { ...before, enabled };
        await apply(
          target,
          false,
          () =>
            setUpdateCommandNativePolicy(
              native.identity,
              enabled,
              env,
              assertCurrent,
              params.timeoutMs,
            ),
          enabled && native.original.enabled === false ? "enable-for-start" : "restore",
        );
      };
      let current = recovery.getRecord();
      const restart = current.effects.at(-1);
      const paired =
        restart?.kind === "service-restart" && restart.runtime === runtime
          ? current.nativeManager!.effects.find((effect) => effect.effectId === restart.effectId)
          : undefined;
      const temporaryEnable =
        ["win32", "darwin"].includes(native.identity.platform) && native.original.enabled === false;
      if (!paired) {
        const prior = current.nativeManager!.effects.at(-1);
        const facts = currentUpdateRecoveryNativeFacts(current.nativeManager!);
        const enabledForStart = temporaryEnable || native.original.enabled === true;
        if (facts.enabled !== enabledForStart || prior?.state === "intent") {
          await setPolicy(enabledForStart);
        }
      }
      current = recovery.getRecord();
      const last = current.nativeManager!.effects.at(-1);
      const facts = currentUpdateRecoveryNativeFacts(current.nativeManager!);
      if (!paired || last?.effectId === paired.effectId) {
        await apply(
          paired?.after ?? {
            ...facts,
            loaded: native.original.loaded,
            stopped: native.original.stopped,
          },
          true,
          async () => {
            await resolveGatewayService().start({
              env,
              stdout: params.stdout,
              assertCurrent,
              preserveAutoStart: true,
              preserveDefinition: true,
            });
          },
        );
      } else if (
        paired.state !== "observed" ||
        last?.action !== "restore" ||
        !isDeepStrictEqual(last.after, { ...paired.after, enabled: native.original.enabled })
      ) {
        throw new UpdateCommandRecoveryPendingError("Native start and policy history conflict.");
      }
      current = recovery.getRecord();
      const started = current.nativeManager!.effects.at(-1)!;
      if (temporaryEnable && (started.after.enabled !== false || started.state === "intent")) {
        await setPolicy(false);
      }
      const restored = recovery.getRecord();
      const observation = await observe();
      assertExactUpdateRecoveryClaim(restored, fence, recovery.options);
      await verifySources();
      if (!isDeepStrictEqual(observation.facts, native.original)) {
        throw new UpdateCommandRecoveryPendingError(
          "Native policy has not returned to its captured state.",
        );
      }
      assertCurrent();
      const result = await operation(assertCurrent);
      assertCurrent();
      return result;
    },
  );
}
