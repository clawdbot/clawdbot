import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    openclawVitestProfileDir: string;
    openclawVitestProfileRunner: string | undefined;
  }
}

/** Root global setup also runs when only independent workspace projects are selected. */
export default async function setupVitestProfiles(root: TestProject) {
  const { normalizePath } = await import("vite");
  const outputDir = root.getProvidedContext().openclawVitestProfileDir;
  const runner = fileURLToPath(new URL("./vitest-profile-runner.mts", import.meta.url));
  const profiler = import.meta.url;
  const preload = `data:text/javascript,${encodeURIComponent(
    `import { installVitestWorkerProfile } from ${JSON.stringify(profiler)}; await installVitestWorkerProfile(${JSON.stringify(outputDir)});`,
  )}`;
  // Vitest awaits global setup before reading each project's worker arguments and
  // runner. Root plugins and reporters are not inherited by independent projects.
  for (const project of root.vitest.projects) {
    if (project.isBrowserEnabled() || !["forks", "threads"].includes(project.config.pool)) {
      throw new Error("Runner profiling supports the forks and threads pools only.");
    }
    if (project.config.execArgv.some((arg) => /^--(?:cpu|heap)-prof/.test(arg))) {
      throw new Error("Use the profiler output directory instead of native CPU/heap flags.");
    }
    // Client environments enforce Vite's filesystem scope. Admit only our injected
    // modules, not their directory, and retain the user's deny rules.
    const allowedFiles = project.vite.config.server.fs.allow;
    for (const file of [runner, fileURLToPath(profiler)].map(normalizePath)) {
      if (!allowedFiles.includes(file)) {
        allowedFiles.push(file);
      }
    }
    project.provide("openclawVitestProfileRunner", project.config.runner);
    project.config.runner = runner;
    project.config.execArgv = [...project.config.execArgv, `--import=${preload}`];
  }
}

/** Own the Inspector session and finish both files before releasing it. */
export async function startVitestProfile(outputDir: string, heap: boolean) {
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 1_000 });
    await session.post("Profiler.start");
    if (heap) {
      await session.post("HeapProfiler.enable");
      await session.post("HeapProfiler.startSampling", { samplingInterval: 512 * 1024 });
    }
  } catch (error) {
    session.disconnect();
    throw error;
  }
  const name = `${process.pid}.${threadId}.${randomUUID()}`;
  let completion: Promise<void> | undefined;
  return () => (completion ??= finish());

  async function finish() {
    try {
      const cpu = session
        .post("Profiler.stop")
        .then(({ profile }) =>
          writeFile(path.join(outputDir, `CPU.${name}.cpuprofile`), JSON.stringify(profile)),
        );
      const memory = heap
        ? session
            .post("HeapProfiler.stopSampling")
            .then(({ profile }) =>
              writeFile(path.join(outputDir, `Heap.${name}.heapprofile`), JSON.stringify(profile)),
            )
        : undefined;
      // Wait for both writes even if one fails; cleanup must not abandon a writer.
      const results = await Promise.allSettled([cpu, memory]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Failed to write Vitest profiles.");
      }
    } finally {
      session.disconnect();
    }
  }
}

const WORKER_PROFILE = Symbol.for("openclaw.vitestWorkerProfile");
function workerProfileState() {
  return globalThis as typeof globalThis & {
    [WORKER_PROFILE]?: ReturnType<typeof startVitestProfile>;
  };
}

export async function installVitestWorkerProfile(outputDir: string) {
  // A Node preload owns one capture per worker, outside Vitest's resettable graph.
  // Reconstructing runners must neither restart nor overlap the heap sampler.
  await (workerProfileState()[WORKER_PROFILE] ??= startVitestProfile(outputDir, true));
}

export async function finishVitestWorkerProfile() {
  const profile = workerProfileState()[WORKER_PROFILE];
  if (!profile) {
    throw new Error("Vitest profiling preload did not initialize this worker.");
  }
  const finish = await profile;
  await finish();
}
