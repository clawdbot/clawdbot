import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveServiceEntrypoint,
  resolveServiceEntrypointIndex,
} from "../../daemon/service-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery.js";
import { gatewayServiceCommandUsesRoot } from "./update-command-service-plan.js";

type RootEvidence = Pick<UpdateRecoveryRecord, "from"> & Partial<UpdateRecoveryRecord>;

/** A missing installation is not an arbitrary service root. This accepts only
 * the two retained directory identities of an interrupted, journaled restore.
 * Full package/source verification and new live owners still precede effects. */
export async function inspectUpdateCommandPackageGap(record: RootEvidence): Promise<boolean> {
  const descriptor = record.package?.descriptor;
  const intent = record.effects?.at(-1);
  if (
    !descriptor?.previous ||
    !record.primaryFailure ||
    !record.checkpoint ||
    !record.afterImages?.length ||
    !record.nativeManager ||
    record.restore ||
    record.terminal ||
    !currentUpdateRecoveryNativeFacts(record.nativeManager).stopped ||
    intent?.kind !== "package-restore" ||
    intent.state !== "intent" ||
    intent.package?.intent.action !== "restore" ||
    descriptor.liveRoot !== record.from.root ||
    descriptor.previous.version !== record.from.version
  ) {
    return false;
  }
  try {
    await fs.lstat(descriptor.liveRoot);
    return false;
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  // The original canonical namespace must still exist. A redirected ancestor or
  // retained symlink cannot borrow the saved installation's executor identity.
  const parent = path.dirname(descriptor.liveRoot);
  if ((await fs.realpath(parent)) !== parent) {
    return false;
  }
  for (const [root, identity] of [
    [descriptor.backupRoot, descriptor.previous.identity],
    [`${descriptor.backupRoot}.candidate`, descriptor.candidate.identity],
  ] as const) {
    const stat = await fs.lstat(root, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      `${stat.dev}:${stat.ino}` !== identity ||
      (await fs.realpath(root)) !== root
    ) {
      return false;
    }
  }
  return true;
}

/** Inspect the same service entrypoint in retained A; never rewrite the actual
 * command or execute retained paths. Captured service files, native identity,
 * stopped state and package bytes are independently verified by replay owners. */
export async function gatewayServiceCommandUsesInterruptedPackageRoot(params: {
  record: RootEvidence;
  command: GatewayServiceCommandConfig;
}): Promise<boolean> {
  if (!(await inspectUpdateCommandPackageGap(params.record))) {
    return false;
  }
  const entry = resolveServiceEntrypoint(params.command);
  const index = resolveServiceEntrypointIndex(params.command.programArguments);
  const root = params.record.from.root;
  if (!entry || index === undefined || !entry.startsWith(`${root}${path.sep}`)) {
    return false;
  }
  const relative = path.relative(root, entry);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const backup = params.record.package!.descriptor.backupRoot;
  const programArguments = [...params.command.programArguments];
  programArguments[index] = path.join(backup, relative);
  return (
    (await gatewayServiceCommandUsesRoot({
      root: backup,
      command: { ...params.command, programArguments },
    })) === true
  );
}
