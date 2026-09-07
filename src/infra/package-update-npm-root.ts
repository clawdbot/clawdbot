import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "./errors.js";
import {
  createPackageIntegrityReader,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";

export function createNpmPackageRootLinkLifecycle(params: {
  liveRoot: string;
  backupRoot: string;
  fingerprint: Extract<PackageRootIntegrityFingerprint, { kind: "link" }>;
  timeoutMs?: number;
}) {
  const assertUnchanged = async (root: string) => {
    const actual = await createPackageIntegrityReader(params.timeoutMs).rootEntry(
      root,
      params.liveRoot,
      "link",
    );
    if (!isDeepStrictEqual(actual, params.fingerprint)) {
      throw new Error("Npm package link changed before activation or retirement");
    }
  };
  return {
    assertLiveUnchanged: () => assertUnchanged(params.liveRoot),
    async acquire(): Promise<{ acquired: true } | { acquired: false; error: string }> {
      await fs.rename(params.liveRoot, params.backupRoot);
      try {
        // Only the moved entry can establish ownership of the retained link.
        await assertUnchanged(params.backupRoot);
        return { acquired: true };
      } catch (error) {
        // A mismatch already disproves ownership. Do not compensate into a
        // live path where another package publisher may now be writing.
        return {
          acquired: false,
          error: `Npm package link backup refused: ${formatErrorMessage(error)}; moved entry retained at ${params.backupRoot}; inspect it before manual recovery`,
        };
      }
    },
    async retire(): Promise<string | null> {
      try {
        await assertUnchanged(params.backupRoot);
        // This observation does not exclude concurrent writers. Non-recursive
        // removal protects a substituted directory and the external checkout.
        await fs.unlink(params.backupRoot);
        return null;
      } catch (error) {
        return `Could not retire retained npm package link at ${params.backupRoot}: ${formatErrorMessage(error)}`;
      }
    },
  };
}

/** Verify the same retained/restored npm root and launcher baseline without inference. */
export async function verifyNpmRootRecovery(
  params: {
    root: string;
    fromBackup: boolean;
    hadPackage: boolean;
    previousRoot: PackageRootIntegrityFingerprint | undefined;
    targetSwapRoot: string;
    shims: readonly { destination: string; backup: string | null; fingerprint?: string }[];
  },
  timeoutMs?: number,
): Promise<void> {
  const { root, fromBackup, hadPackage, previousRoot, targetSwapRoot, shims } = params;
  const reader = createPackageIntegrityReader(timeoutMs);
  await reader.observe(fromBackup ? "retained" : "restored", async () => {
    if (
      hadPackage
        ? !previousRoot ||
          !isDeepStrictEqual(
            await reader.rootEntry(root, targetSwapRoot, previousRoot.kind),
            previousRoot,
          )
        : !fromBackup && (await reader.exists(root))
    ) {
      throw new Error(
        `Package rollback verification failed: retained package ${previousRoot?.kind === "link" ? "link" : "tree"} changed`,
      );
    }
    for (const shim of shims) {
      const target = fromBackup ? shim.backup : shim.destination;
      if (
        shim.backup
          ? !target || (await reader.launcher(target)) !== shim.fingerprint
          : !fromBackup && (await reader.exists(shim.destination))
      ) {
        throw new Error(
          `Package rollback verification failed: launcher ${shim.destination} changed`,
        );
      }
    }
  });
}
