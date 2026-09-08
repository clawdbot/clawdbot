import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "./errors.js";
import {
  createPackageIntegrityReader,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";
import { movePathWithCopyFallback } from "./replace-file.js";

export async function activateStagedNpmPackageRoot(
  source: string,
  destination: string,
): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isSymbolicLink()) {
    await movePathWithCopyFallback({
      from: source,
      sourceHardlinks: "allow",
      to: destination,
    });
    return;
  }

  // npm represents global local-directory installs as relative symlinks. Moving
  // one changes its meaning, so activate the same canonical source explicitly.
  const canonicalSource = await fs.realpath(source);
  await fs.symlink(
    canonicalSource,
    destination,
    process.platform === "win32" ? "junction" : undefined,
  );
}

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
