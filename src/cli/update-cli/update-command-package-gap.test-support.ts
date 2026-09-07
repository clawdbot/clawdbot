import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { expect, vi } from "vitest";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import * as packageFilesystem from "../../infra/package-update-filesystem.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as updateShared from "./shared.js";
import { completeUpdateCommandCandidate } from "./update-command-candidate-completion.js";
import { resumePendingUpdateCommand } from "./update-command-pending-replay.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";
import { updateCommand } from "./update-command.js";

export const packageGapReplayModes = [
  "replay-package-gap",
  "replay-package-gap-config",
  "replay-package-gap-package",
  "replay-package-gap-command",
  "replay-package-gap-manager",
  "replay-package-gap-profile",
] as const;

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
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`fixture CLI exit ${code}`);
    });
    const root = vi.spyOn(updateShared, "resolveUpdateRoot").mockResolvedValue(invoker);
    const outcome = await withEnvAsync(
      {
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_PROFILE: mode === "replay-package-gap-profile" ? "unrelated" : undefined,
      },
      () => updateCommand({ json: true, yes: true }),
    ).catch((cause: unknown) => cause);
    root.mockRestore();
    exit.mockRestore();
    if (mode !== "replay-package-gap") {
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
    const displaced = await fs.stat(`${descriptor.backupRoot}.candidate`);
    expect([displaced.dev, displaced.ino]).toEqual([candidate.dev, candidate.ino]);
  };
}
