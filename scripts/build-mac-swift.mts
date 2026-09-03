#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { runManagedCommand, signalExitCode } from "./lib/managed-child-process.mts";

const [root, configuration, peekabooCommit, skipMlx, resultsRoot, ...architectures] =
  process.argv.slice(2);
if (
  !root ||
  !configuration ||
  !peekabooCommit ||
  !skipMlx ||
  !resultsRoot ||
  architectures.length === 0 ||
  architectures.length > 2 ||
  new Set(architectures).size !== architectures.length ||
  architectures.some((arch) => arch !== "arm64" && arch !== "x86_64")
) {
  throw new Error(
    "Expected build root, configuration, source revision, MLX flag, result directory and unique macOS architectures",
  );
}
const concurrency = Math.min(architectures.length, availableParallelism());
const jobs = Math.max(1, Math.floor(availableParallelism() / concurrency));
const controller = new AbortController();
const owned: Array<{ arch: string; lock: string; work: string; treeSafe: boolean }> = [];
const failures: unknown[] = [];
let parentSignal: NodeJS.Signals | undefined;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const signalHandlers = signals.map((signal) => {
  const handler = () => {
    parentSignal ??= signal;
    controller.abort(new Error(`Swift build interrupted by ${signal}`));
  };
  process.on(signal, handler);
  return { signal, handler };
});
const worker = path.join(root, "scripts/lib/mac-swift-build.sh");
const workerArgs = (operation: string, arch: string, work: string) => [
  worker,
  operation,
  root,
  arch,
  configuration,
  String(jobs),
  peekabooCommit,
  skipMlx,
  work,
];

await mkdir(resultsRoot, { recursive: true });
try {
  for (let offset = 0; offset < architectures.length; offset += concurrency) {
    if (controller.signal.aborted || parentSignal) {
      break;
    }
    await Promise.allSettled(
      architectures.slice(offset, offset + concurrency).map(async (arch) => {
        const lock = path.join(root, "apps/macos/.build", `.openclaw-package-${arch}.lock`);
        const work = path.join(resultsRoot, arch);
        let ownership: (typeof owned)[number] | undefined;
        try {
          await mkdir(path.dirname(lock), { recursive: true });
          // SwiftPM's lock does not cover our checkout resource patches.
          await mkdir(lock);
          ownership = { arch, lock, work, treeSafe: true };
          owned.push(ownership);
          await mkdir(work);
          const code = await runManagedCommand({
            bin: "/bin/bash",
            args: workerArgs("build", arch, work),
            requireProcessTreeExit: true,
            signal: controller.signal,
          });
          if (code !== 0) {
            throw new Error(`Swift ${arch} build failed with exit code ${code}`);
          }
          const compiled = (await readFile(path.join(work, "peekaboo-commit"), "utf8")).trim();
          if (compiled !== peekabooCommit) {
            throw new Error(`Swift ${arch} compiled a different Peekaboo source`);
          }
        } catch (error) {
          if (
            ownership &&
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EPROCESSGROUP_CLEANUP_FAILED"
          ) {
            ownership.treeSafe = false;
          }
          failures.push(error);
          if (!controller.signal.aborted) {
            controller.abort(error);
          }
        }
      }),
    );
  }
} finally {
  // All writers have settled before mounts, patched sources or locks are retired.
  for (const owner of owned) {
    if (!owner.treeSafe) {
      continue;
    }
    try {
      const code = await runManagedCommand({
        bin: "/bin/bash",
        args: workerArgs("cleanup", owner.arch, owner.work),
        requireProcessTreeExit: true,
      });
      if (code !== 0) {
        owner.treeSafe = false;
        failures.push(new Error(`Swift ${owner.arch} cleanup failed with exit code ${code}`));
      } else {
        await rm(owner.lock, { recursive: true });
      }
    } catch (error) {
      owner.treeSafe = false;
      failures.push(error);
    }
  }
}
if (owned.every((owner) => owner.treeSafe)) {
  await writeFile(path.join(resultsRoot, "cleanup-complete"), "verified\n", { flag: "wx" });
}
for (const { signal, handler } of signalHandlers) {
  process.off(signal, handler);
}
for (const failure of failures) {
  console.error(failure);
}
if (owned.some((owner) => !owner.treeSafe)) {
  console.error(
    `Swift cleanup could not be verified; retained work and ownership locks under ${resultsRoot}`,
  );
  process.exitCode = 2;
} else if (parentSignal) {
  process.exitCode = signalExitCode(parentSignal);
} else if (failures.length > 0) {
  process.exitCode = 1;
}
