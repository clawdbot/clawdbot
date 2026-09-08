import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { expect, vi } from "vitest";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import * as packageFilesystem from "../../infra/package-update-filesystem.js";
import * as checkpointRestore from "../../infra/update-checkpoint-restore.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as updateShared from "./shared.js";
import { interruptReplayAgentFamily } from "./update-command-agent-family.test-support.js";
import { completeUpdateCommandCandidate } from "./update-command-candidate-completion.js";
import { resumePendingUpdateCommand } from "./update-command-pending-replay.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";
import { updateCommand } from "./update-command.js";

export const successfulPackageGapReplayModes: readonly string[] = [
  "replay-package-gap-agent-wal",
  "replay-package-gap-agent-empty-wal",
  "replay-package-gap-agent-writer",
  "replay-package-gap-agent-reader",
  "replay-package-gap",
  "replay-package-gap-slow-checkpoint",
  "replay-package-gap-checkpoint-intent",
  "replay-package-gap-preparing",
];
export const packageGapReplayModes = [
  ...successfulPackageGapReplayModes,
  "replay-package-gap-config",
  "replay-package-gap-package",
  "replay-package-gap-command",
  "replay-package-gap-manager",
  "replay-package-gap-profile",
];

/** Lose the process after its journaled candidate displacement, with the actual
 * original package, checkpoint and failed-Doctor after-image still retained. */
export async function interruptPackageGapReplay(
  params: FinishUpdateParams,
  mode: string,
): Promise<() => Promise<void>> {
  const recovery = params.opts.recovery!;
  const env = params.opts.run!.env;
  const descriptor = recovery.getRecord().package!.descriptor;
  const previous = await fs.stat(descriptor.backupRoot);
  const candidate = await fs.stat(descriptor.liveRoot);
  let cut = false;
  const restore = vi
    .spyOn(packageFilesystem, "restoreNpmPackageRoot")
    .mockImplementation(async (input) => {
      expect(input.candidatePresent).toBe(true);
      input.assertCurrent?.();
      await fs.rename(input.liveRoot, input.displacedRoot);
      cut = true;
      throw new Error("fixture process interrupted after candidate displacement");
    });
  const interrupted = await completeUpdateCommandCandidate({
    ...params,
    failure: {
      cause: new Error("fixture candidate Doctor failure"),
      detail: "Candidate phase requires restoration.",
    },
  }).catch((cause: unknown) => cause);
  restore.mockRestore();
  expect(cut, inspect(interrupted, { depth: 12 })).toBe(true);
  expect(interrupted).toBeInstanceOf(Error);
  expect(formatErrorMessage(interrupted)).toContain("fixture candidate Doctor failure");
  expect(formatErrorMessage(interrupted)).toContain(
    "fixture process interrupted after candidate displacement",
  );
  await expect(fs.lstat(descriptor.liveRoot)).rejects.toMatchObject({ code: "ENOENT" });
  const record = recovery.getRecord();
  expect(record.effects.at(-1)).toMatchObject({ kind: "package-restore", state: "intent" });
  expect(record.checkpoint).toBeDefined();
  expect(record.afterImages?.length).toBeGreaterThan(0);
  // The original installation owner is still alive: even valid retained
  // evidence must not admit a concurrent executor.
  await expect(
    resumePendingUpdateCommand({
      opts: { json: true, yes: true },
      root: params.root,
      timeoutMs: params.updateStepTimeoutMs,
    }),
  ).rejects.toThrow("Another update executor");
  return async () => {
    closeOpenClawStateDatabaseForTest();
    const invoker = path.join(path.dirname(env.OPENCLAW_STATE_DIR!), "repair-cli");
    await fs.mkdir(invoker);
    await fs.writeFile(
      path.join(invoker, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2.0.0" }),
    );
    if (mode === "replay-package-gap-config") {
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "operator edit must survive");
    } else if (mode === "replay-package-gap-package") {
      await fs.appendFile(
        path.join(descriptor.backupRoot, "dist", "index.js"),
        "\n// operator edit",
      );
    } else if (mode === "replay-package-gap-command") {
      const service = resolveGatewayService();
      const command = await service.readCommand(env);
      vi.spyOn(service, "readCommand").mockResolvedValue({
        ...command!,
        programArguments: [process.execPath, path.join(invoker, "dist", "index.js"), "gateway"],
      });
    } else if (mode === "replay-package-gap-manager") {
      const service = resolveGatewayService();
      const runtime = await service.readRuntime(env);
      vi.spyOn(service, "readRuntime").mockResolvedValue({
        ...runtime,
        systemd: { ...runtime.systemd, unit: "openclaw-gateway.service", managerUid: 2999 },
      });
    }
    if (mode === "replay-package-gap-slow-checkpoint") {
      const prepare = checkpointRestore.prepareUpdateCheckpointRestore;
      vi.spyOn(checkpointRestore, "prepareUpdateCheckpointRestore").mockImplementation(
        async (input) => {
          // Real elapsed time outlasts the short fixture lease while the real
          // package, source locks, executor and checkpoint work remain unchanged.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 11_000);
          });
          input.assertQuiescent();
          return prepare(input);
        },
      );
    }
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`fixture CLI exit ${code}`);
    });
    const root = vi.spyOn(updateShared, "resolveUpdateRoot").mockResolvedValue(invoker);
    const invoke = () =>
      withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_ID: undefined,
          OPENCLAW_PROFILE: mode === "replay-package-gap-profile" ? "unrelated" : undefined,
        },
        () => updateCommand({ json: true, yes: true }),
      ).catch((cause: unknown) => cause);
    const privateEvidence: { parent: string; name: string; bytes: Buffer }[] = [];
    if (["replay-package-gap-checkpoint-intent", "replay-package-gap-preparing"].includes(mode)) {
      const prepare = checkpointRestore.prepareUpdateCheckpointRestore;
      vi.spyOn(checkpointRestore, "prepareUpdateCheckpointRestore").mockImplementationOnce(
        async (input) =>
          prepare({
            ...input,
            prepareSharedDatabase(databases) {
              if (mode === "replay-package-gap-preparing") {
                input.prepareSharedDatabase(databases);
              }
              throw new Error("fixture interrupted at checkpoint preparation");
            },
          }),
      );
      const preparationInterrupted = await invoke();
      expect(formatErrorMessage(preparationInterrupted)).toContain(
        "fixture interrupted at checkpoint preparation",
      );
      const retained = loadUpdateRecovery(record.runId, { env })!;
      expect(retained.effects.at(-1)).toMatchObject({
        kind: "checkpoint-restore",
        state: "intent",
      });
      if (mode === "replay-package-gap-preparing") {
        expect(retained.restore).toMatchObject({ phase: "preparing", planSha256: null });
      } else {
        expect(retained.restore).toBeFalsy();
      }
      const parent = path.join(env.OPENCLAW_STATE_DIR!, "state");
      for (const name of await fs.readdir(parent)) {
        if (name.startsWith(".openclaw-restore-") && !name.includes(".abandoned-")) {
          privateEvidence.push({
            parent,
            name,
            bytes: await fs.readFile(path.join(parent, name, "current.sqlite")),
          });
        }
      }
      expect(privateEvidence.length).toBeGreaterThan(0);
      expect(retained.terminal).toBeFalsy();
      const originalLive = await fs.stat(descriptor.liveRoot);
      expect([originalLive.dev, originalLive.ino]).toEqual([previous.dev, previous.ino]);
      expect(resolveGatewayService().start).not.toHaveBeenCalled();
      // A real durable writer must still exclude fresh publication. Merely
      // sharing this async task does not delegate its lease to the updater.
      await withPluginLifecycleLease({ env, schemaPolicy: "existing" }, async () => {
        const refused = await invoke();
        expect(formatErrorMessage(refused)).toContain("lease still prevents publication recovery");
        const pending = loadUpdateRecovery(record.runId, { env })!;
        expect(pending.effects).toEqual(retained.effects);
        expect(pending.restore).toEqual(retained.restore);
        expect(pending.terminal).toBeFalsy();
        expect(resolveGatewayService().start).not.toHaveBeenCalled();
      });
      closeOpenClawStateDatabaseForTest();
    }
    const outcome = mode.startsWith("replay-package-gap-agent-")
      ? await interruptReplayAgentFamily({ env, mode, invoke, runId: record.runId })
      : await invoke();
    root.mockRestore();
    exit.mockRestore();
    if (!successfulPackageGapReplayModes.includes(mode)) {
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(UpdateCommandFinalizedRecoveryFailure);
      await expect(fs.lstat(descriptor.liveRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const pending = loadUpdateRecovery(record.runId, { env })!;
      expect(pending.terminal).toBeUndefined();
      expect(pending.effects.at(-1)).toEqual(record.effects.at(-1));
      if (mode === "replay-package-gap-config") {
        expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(
          "operator edit must survive",
        );
      }
      return;
    }
    expect(outcome, inspect(outcome, { depth: 12 })).toBeInstanceOf(
      UpdateCommandFinalizedRecoveryFailure,
    );
    const current = loadUpdateRecovery(record.runId, { env })!;
    expect(current.claimId).not.toBe(record.claimId);
    expect(current.terminal).toMatchObject({
      status: "rolled-back",
      receipt: { runtime: "previous" },
    });
    const restored = await fs.stat(descriptor.liveRoot);
    expect([restored.dev, restored.ino]).toEqual([previous.dev, previous.ino]);
    for (const evidence of privateEvidence) {
      const retained =
        mode === "replay-package-gap-preparing"
          ? (await fs.readdir(evidence.parent)).find((name) =>
              name.startsWith(evidence.name + ".abandoned-"),
            )
          : evidence.name;
      expect(retained).toBeDefined();
      expect(await fs.readFile(path.join(evidence.parent, retained!, "current.sqlite"))).toEqual(
        evidence.bytes,
      );
    }
    const displaced = await fs.stat(`${descriptor.backupRoot}.candidate`);
    expect([displaced.dev, displaced.ino]).toEqual([candidate.dev, candidate.ino]);
  };
}
