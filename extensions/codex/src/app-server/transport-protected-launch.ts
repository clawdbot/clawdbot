import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
import type { CodexAppServerStartOptions } from "./config.js";
import { assertCodexDirectLaunchArgs } from "./launch-args.js";
import {
  resolveCodexAppServerCommandPath,
  resolveCodexRuntimeFilesystemDescriptor,
} from "./runtime-artifact.js";

const RECOVERY = "https://docs.openclaw.ai/plugins/codex-harness#sandboxed-startup-recovery";

/** Native program semantics remain operator-trusted; script launchers need known native targets. */
async function assertNativeImage(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const magic = bytes.toString("hex");
    const native =
      bytesRead === 4 &&
      (magic === "7f454c46" ||
        [
          "feedface",
          "cefaedfe",
          "feedfacf",
          "cffaedfe",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ].includes(magic) ||
        bytes.subarray(0, 2).toString("ascii") === "MZ");
    if (!native) {
      throw new Error("The selected runtime is not a native executable");
    }
  } finally {
    await handle.close();
  }
}

/** Inspect every alias ancestor: resolving only the final file can hide a writable symlink. */
async function assertOutsideWritableRoots(
  filePath: string,
  roots: readonly string[],
): Promise<void> {
  for (let current = path.resolve(filePath); ; current = path.dirname(current)) {
    const resolved = await canonicalPathFromExistingAncestor(current);
    if (roots.some((root) => isPathInside(root, resolved))) {
      throw new Error("Runtime files or their launch paths overlap a model-writable mount");
    }
    if (path.dirname(current) === current) {
      return;
    }
  }
}

/** Validate the final candidate before host spawn, including managed fallback candidates. */
export async function resolveProtectedCodexSpawnCommand(
  options: CodexAppServerStartOptions,
  env: NodeJS.ProcessEnv,
  command: string,
  entrypointPaths: readonly string[] = [],
): Promise<string> {
  try {
    assertCodexDirectLaunchArgs(options.args);
    const roots = await Promise.all(
      (options.protectedLaunchRoots ?? []).map((root) =>
        canonicalPathFromExistingAncestor(path.resolve(root)),
      ),
    );
    const descriptor = await resolveCodexRuntimeFilesystemDescriptor({
      startOptions: options,
      spawnIdentity: {
        command: options.command,
        argsFingerprint: createHash("sha256").update(JSON.stringify(options.args)).digest("hex"),
      },
      env,
    });
    const commandPath = await resolveCodexAppServerCommandPath(
      command,
      env,
      path.resolve(options.cwd ?? process.cwd()),
    );
    const materializedPaths = [
      commandPath,
      ...entrypointPaths.map((entrypoint) =>
        path.resolve(options.cwd ?? process.cwd(), entrypoint),
      ),
    ];
    for (const materializedPath of materializedPaths) {
      await assertOutsideWritableRoots(materializedPath, roots);
      const canonical = await fs.realpath(materializedPath);
      if (canonical !== descriptor.nativePath && !descriptor.invocationPaths.includes(canonical)) {
        throw new Error("The resolved launch inputs changed before protected startup");
      }
    }
    const files = new Set([
      ...materializedPaths,
      descriptor.commandPath,
      descriptor.commandRealPath,
      descriptor.nativePath,
      ...descriptor.invocationPaths,
      ...(descriptor.codeModeHostPath ? [descriptor.codeModeHostPath] : []),
    ]);
    // Package managers may hard-link trusted installed files. Protect launch paths;
    // installation/cache topology remains operator-owned, as with native binary semantics.
    for (const file of files) {
      await assertOutsideWritableRoots(file, roots);
      const stat = await fs.stat(file);
      if (!stat.isFile()) {
        throw new Error("Runtime launch files must be regular files");
      }
    }
    await assertOutsideWritableRoots(descriptor.codeModeHostCandidatePath, roots);
    const packageRoot = descriptor.packageRoot;
    if (packageRoot) {
      await assertOutsideWritableRoots(packageRoot, roots);
      if (roots.some((root) => isPathInside(packageRoot, root))) {
        throw new Error("The runtime package contains a model-writable mount");
      }
    }
    if (process.platform !== "win32" && descriptor.commandRealPath !== descriptor.nativePath) {
      // An npm shebang can invoke /usr/bin/env after validation. Protect every
      // search directory, including currently empty entries where node could appear.
      for (const entry of (env.PATH ?? "").split(path.delimiter)) {
        await assertOutsideWritableRoots(
          path.resolve(options.cwd ?? process.cwd(), entry || "."),
          roots,
        );
      }
    }
    await assertNativeImage(descriptor.nativePath);
    // Keep the invocation/argv owner intact, including official npm entrypoints.
    // Pin only executable lookup so a relative command or PATH entry cannot redirect it.
    return await fs.realpath(commandPath);
  } catch (cause) {
    throw new Error(
      `Sandboxed Codex requires a protected native executable or official npm entrypoint with direct app-server arguments. Remove custom script wrappers and keep runtime files outside writable mounts; see ${RECOVERY}.`,
      { cause },
    );
  }
}
