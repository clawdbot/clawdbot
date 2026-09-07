import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveGatewayService } from "../../daemon/service.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import {
  cancelUpdateRecoveryRestart,
  inspectUpdateRecoveryNativeManager,
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeNotApplied,
  recordUpdateRecoveryNativeObservation,
  type UpdateRecoveryNativeFacts,
} from "../../infra/update-run-recovery-native.js";
import { assertExactUpdateRecoveryClaim } from "../../infra/update-run-recovery.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import { setUpdateCommandNativePolicy } from "./update-command-native-policy.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Retain the real executor/source owners through settling ambiguous dispatch,
 * suppression, stop and cancellation. No historical row grants native authority. */
export async function quiesceFailedUpdateCommand(params: {
  recovery: UpdateCommandRecovery;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const { recovery, env } = params;
  const initial = recovery.getRecord();
  if (
    !initial.primaryFailure ||
    !initial.checkpoint ||
    !initial.nativeManager ||
    initial.terminal
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Failed update quiescence lacks its live recovery binding.",
    );
  }
  await withUpdateCommandSourceOwnership({ recovery, env, mutation: true }, async (source) => {
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
    const verify = async () => {
      const expected = recovery.getRecord();
      await verifySources();
      assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
    };
    await verify();
    let current = recovery.getRecord();
    const pending = current.nativeManager!.effects.at(-1);
    if (pending?.state === "intent") {
      const inspected = await inspectUpdateRecoveryNativeManager(
        current,
        observe,
        fence,
        recovery.options,
      );
      await verify();
      if (inspected.status === "after") {
        recovery.onRecord(
          (
            await recordUpdateRecoveryNativeObservation(
              current,
              pending.effectId,
              observe,
              fence,
              recovery.options,
            )
          ).record,
        );
      } else if (inspected.status === "before") {
        recovery.onRecord(
          await recordUpdateRecoveryNativeNotApplied(
            current,
            pending.effectId,
            observe,
            fence,
            recovery.options,
          ),
        );
      } else {
        throw new UpdateCommandRecoveryPendingError(
          "Native failure conflicts with its dispatched before/after facts.",
        );
      }
    }
    current = recovery.getRecord();
    const last = current.nativeManager!.effects.at(-1);
    const restart = current.effects.at(-1);
    if (
      last?.state === "not-applied" &&
      restart?.state === "intent" &&
      restart.kind === "service-restart" &&
      last.effectId === restart.effectId
    ) {
      recovery.onRecord(
        await cancelUpdateRecoveryRestart(current, observe, fence, recovery.options),
      );
    }
    const apply = async (
      action: "suppress" | "stop",
      target: UpdateRecoveryNativeFacts,
      dispatch: () => Promise<void>,
    ) => {
      await verify();
      const intent = await recordUpdateRecoveryNativeIntent(
        recovery.getRecord(),
        { effectId: randomUUID(), action, target, observe },
        fence,
        recovery.options,
      );
      recovery.onRecord(intent.record);
      let failure: unknown;
      if (intent.status === "before") {
        try {
          assertCurrent();
          await dispatch();
        } catch (error) {
          failure = error;
        }
      }
      await verify();
      const observed = await recordUpdateRecoveryNativeObservation(
        intent.record,
        intent.record.nativeManager!.effects.at(-1)!.effectId,
        observe,
        fence,
        recovery.options,
      );
      recovery.onRecord(observed.record);
      if (observed.status !== "after") {
        throw new UpdateCommandRecoveryPendingError(
          "Failed candidate remains pending native quiescence.",
          { cause: failure },
        );
      }
    };
    const manager = recovery.getRecord().nativeManager!;
    let facts = currentUpdateRecoveryNativeFacts(manager);
    if (!facts.exists) {
      throw new UpdateCommandRecoveryPendingError(
        "Captured native service disappeared before quiescence.",
      );
    }
    if (facts.enabled) {
      await apply("suppress", { ...facts, enabled: false }, () =>
        setUpdateCommandNativePolicy(manager.identity, false, env, assertCurrent, params.timeoutMs),
      );
    }
    facts = currentUpdateRecoveryNativeFacts(recovery.getRecord().nativeManager!);
    await apply(
      "stop",
      {
        ...facts,
        stopped: true,
        loaded: manager.identity.platform === "darwin" ? false : facts.loaded,
      },
      () => resolveGatewayService().stop({ env, stdout: params.stdout, assertCurrent }),
    );
    current = recovery.getRecord();
    const final = await observe();
    await verify();
    if (
      !final.facts.stopped ||
      !isDeepStrictEqual(final.facts, currentUpdateRecoveryNativeFacts(current.nativeManager!))
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Failed candidate stop is not independently confirmed.",
      );
    }
    const incomplete = current.effects.at(-1);
    if (incomplete?.kind === "service-restart" && incomplete.state === "intent") {
      recovery.onRecord(
        await cancelUpdateRecoveryRestart(current, observe, fence, recovery.options),
      );
    }
  });
}
