import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { RecoveryAfterImageFixture } from "./update-run-recovery-after-image-fixture.test-support.js";
import {
  acceptUpdateRecoveryHandoff,
  bindUpdateRecoveryAfterImage,
  loadUpdateRecovery,
  prepareUpdateRecoveryHandoff,
  recordUpdateRecoveryIntent,
  type UpdateRecoveryFence,
} from "./update-run-recovery.js";

export function defineUpdateRecoveryMutationImageTests(
  fixture: () => Promise<RecoveryAfterImageFixture>,
  fence: UpdateRecoveryFence,
) {
  it.each(["success", "failure"])(
    "atomically acknowledges the sealed runtime mutation (%s)",
    async (mode) => {
      const f = await fixture();
      const first = bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
      const transfer = prepareUpdateRecoveryHandoff(first, fence, f.options);
      const accepted = acceptUpdateRecoveryHandoff(transfer.handoff, f.runtime, fence, f.options);
      const effectId = randomUUID();
      const intent = recordUpdateRecoveryIntent(
        accepted,
        {
          effectId,
          kind: "runtime-mutation",
          resourceId: "doctor",
          runtime: "candidate",
        },
        fence,
        f.options,
      );
      const afterUpdate = await f.capture("runtime-owned-output");
      const input = {
        checkpointRef: f.checkpoint.ref,
        afterUpdate,
        effectIds: [effectId],
        mutation: {
          effectId,
          observedIdentity: "doctor-owned-output",
          ...(mode === "failure" ? { failureCode: "candidate-doctor" } : {}),
        },
      };
      // A rejected image cannot leave a separately observed effect or failure behind.
      expect(() =>
        bindUpdateRecoveryAfterImage(
          intent,
          { ...input, afterUpdate: f.checkpoint },
          fence,
          f.options,
        ),
      ).toThrow();
      expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(intent);
      expect(() =>
        bindUpdateRecoveryAfterImage(
          intent,
          { ...input, mutation: { ...input.mutation, effectId: randomUUID() } },
          fence,
          f.options,
        ),
      ).toThrow();
      expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(intent);
      const bound = bindUpdateRecoveryAfterImage(intent, input, fence, f.options);
      closeOpenClawStateDatabaseForTest();
      const reopened = loadUpdateRecovery(f.run.runId, f.options)!;
      expect(reopened).toEqual(bound);
      expect(reopened.revision).toBe(intent.revision + 1);
      expect(reopened.effects.at(-1)).toMatchObject({
        effectId,
        state: "observed",
        observedIdentity: "doctor-owned-output",
      });
      expect(reopened.afterImages!.at(-1)).toMatchObject({
        effectIds: [effectId],
        afterUpdate,
        boundAtRevision: reopened.revision,
      });
      expect(reopened.primaryFailure).toEqual(
        mode === "failure" ? { code: "candidate-doctor", effectId } : null,
      );
    },
  );
}
