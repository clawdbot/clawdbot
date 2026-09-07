import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import type {
  PackageRecoveryHooks,
  PreparePackageRecovery,
} from "../../infra/package-update-recovery.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { prepareManagedServiceNativeHandoff } from "../../infra/update-managed-service-native-control.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import {
  assertExactUpdateRecoveryClaim,
  beginUpdateRecovery,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { readPackageVersion, resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";

/** Enter only from the package owner's validated, retained staging boundary.
 * The serialized source facts are rechecked against files and the original live
 * invocation; they are not a substitute for that executor's ownership.
 */
export async function beginUpdateCommandStartup(params: {
  opts: UpdateCommandOptions;
  root: string;
  env: NodeJS.ProcessEnv;
  source: Parameters<PreparePackageRecovery>[0];
  nodeRunner?: string;
  managedService?: boolean;
  timeoutMs?: number;
}) {
  const { opts, source } = params;
  const run = opts.run;
  const executor = run?.executorFence;
  if (!run || !executor || opts.recovery) {
    throw new UpdateCommandRecoveryPendingError("Startup requires its original unused executor.");
  }
  const assertCurrent = () => {
    if (opts.run !== run || run.executorFence !== executor) {
      throw new UpdateCommandRecoveryPendingError("Startup lost its admitted invocation.");
    }
    executor.assertCurrent();
  };
  assertCurrent();
  if (
    resolveUpdateInstallRoot(params.root) !== resolveUpdateInstallRoot(source.liveRoot) ||
    resolveOpenClawStateSqlitePath(params.env) !== resolveOpenClawStateSqlitePath(run.env) ||
    !source.previous
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Startup source differs from its admitted installation.",
    );
  }
  const [
    previousVersion,
    candidateVersion,
    previousBuild,
    candidateBuild,
    previousNode,
    candidateNode,
  ] = await Promise.all([
    readPackageVersion(source.liveRoot),
    readPackageVersion(source.stageRoot),
    readBuiltGatewayBuildId(source.liveRoot),
    readBuiltGatewayBuildId(source.stageRoot),
    fs.realpath(process.execPath),
    fs.realpath(params.nodeRunner ?? resolveNodeRunner()),
  ]);
  assertCurrent();
  if (
    previousVersion !== source.previous.version ||
    candidateVersion !== source.candidate.version
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Validated package version changed before startup.",
    );
  }
  // Versions alone cannot bind a package whose files changed without a version bump.
  const reader = createPackageIntegrityReader();
  const [previous, candidate] = await Promise.all([
    reader.tree(source.liveRoot, source.liveRoot),
    reader.tree(source.stageRoot, source.liveRoot),
  ]);
  assertCurrent();
  if (
    !isDeepStrictEqual(previous, source.previous) ||
    !isDeepStrictEqual(candidate, source.candidate)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Validated package identity changed before startup.",
    );
  }
  const managedNativeHandoff = await prepareManagedServiceNativeHandoff({
    assertCurrent,
    timeoutMs: params.timeoutMs,
  });
  assertCurrent();
  const root = resolveUpdateInstallRoot(source.liveRoot);
  const transactionId = randomUUID();
  const runtime = {
    runId: run.runId,
    from: {
      root,
      nodePath: previousNode,
      version: previousVersion,
      buildId: previousBuild ?? null,
    },
    to: {
      root,
      nodePath: candidateNode,
      version: candidateVersion,
      buildId: candidateBuild ?? null,
    },
  };
  let record: UpdateRecoveryRecord | undefined;
  const requireRecord = () => {
    if (!record || opts.recovery !== recovery) {
      throw new UpdateCommandRecoveryPendingError("Startup package has not been durably admitted.");
    }
    return record;
  };
  const fence = { assertCurrent };
  const recovery: UpdateCommandRecovery = {
    fence,
    options: { env: run.env },
    managedNativeHandoff,
    getRecord: requireRecord,
    onRecord(next) {
      assertCurrent();
      const current = requireRecord();
      if (next.runId !== current.runId || next.transactionId !== current.transactionId) {
        throw new UpdateCommandRecoveryPendingError("Startup record changed transaction.");
      }
      record = next;
    },
    assertReady() {
      // Startup never grants terminal authority. The serving owner must finish
      // a fresh readiness/terminal interval in the executing runtime.
      throw new UpdateCommandRecoveryPendingError("Startup has no terminal readiness authority.");
    },
  };
  let downstream: PackageRecoveryHooks | undefined;
  const packageHooks = () => {
    requireRecord();
    return (downstream ??= createUpdateRecoveryPackageHooks(recovery));
  };
  const hooks: PackageRecoveryHooks = {
    transactionId,
    async persistDescriptor(observed) {
      assertCurrent();
      if (record) {
        return await packageHooks().persistDescriptor(observed);
      }
      const descriptor = observed.descriptor;
      if (
        opts.recovery ||
        descriptor.transactionId !== transactionId ||
        descriptor.liveRoot !== source.liveRoot ||
        descriptor.stageRoot !== source.stageRoot ||
        !isDeepStrictEqual(descriptor.previous, previous) ||
        !isDeepStrictEqual(descriptor.candidate, candidate)
      ) {
        throw new UpdateCommandRecoveryPendingError("Startup package observation changed.");
      }
      // The first durable row contains the complete package locator. Losing an
      // acknowledgement cannot strand a pending claim with unaddressable staging.
      const initial = beginUpdateRecovery({ ...runtime, initialPackage: observed }, executor, {
        env: run.env,
      });
      record = initial;
      opts.recovery = recovery;
      assertExactUpdateRecoveryClaim(initial, fence, { env: run.env });
      await managedNativeHandoff?.commit(() =>
        assertExactUpdateRecoveryClaim(initial, fence, { env: run.env }),
      );
      await captureUpdateCommandPreimages({
        recovery,
        env: params.env,
        managedService: params.managedService,
        timeoutMs: params.timeoutMs,
      });
      const prepared = requireRecord();
      return {
        assertCurrent: () => assertExactUpdateRecoveryClaim(prepared, fence, { env: run.env }),
      };
    },
    async beforeEffect(effect, context) {
      assertCurrent();
      return await packageHooks().beforeEffect(effect, context);
    },
  };
  return {
    recovery,
    hooks,
    assertRecord(expected: UpdateRecoveryRecord) {
      assertCurrent();
      const current = requireRecord();
      assertExactUpdateRecoveryClaim(expected, fence, { env: run.env });
      if (!isDeepStrictEqual(expected, current)) {
        throw new UpdateCommandRecoveryPendingError("Startup record changed during observation.");
      }
    },
  };
}
