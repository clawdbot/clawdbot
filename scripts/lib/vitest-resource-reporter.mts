import os from "node:os";
import type { Reporter, TestModule, TestProject, TestSpecification, Vitest } from "vitest/node";
import { detectVitestHostInfo } from "./vitest-local-scheduling.mts";

function writeReceipt(kind: string, value: unknown) {
  process.stdout.write(`[vitest:${kind}] ${JSON.stringify(value)}\n`);
}

// Collection replaces the queued module object; its id is a 32-bit hash.
// Correlate the native project/module/pool identity across those callbacks.
function moduleKey(spec: TestSpecification) {
  return JSON.stringify([spec.project.name, spec.moduleId, spec.pool]);
}

// Opt in through Vitest's existing --reporter option. Observe the resolved
// process and native events without changing test selection or pool policy.
export default class VitestResourceReporter implements Reporter {
  private started = 0;
  private cpu = process.cpuUsage();
  private queued = new Map<string, number>();

  onInit(ctx: Vitest) {
    writeReceipt("resources", {
      pid: process.pid,
      node: process.version,
      libuv: process.versions.uv,
      platform: process.platform,
      arch: process.arch,
      ...detectVitestHostInfo(),
      osLogicalCpuCount: os.cpus().length,
      constrainedMemoryBytes: process.constrainedMemory(),
      availableMemoryBytes: process.availableMemory(),
      rootMaxWorkers: ctx.config.maxWorkers ?? null,
    });
  }

  onTestRunStart(specs: readonly TestSpecification[]) {
    this.started = performance.now();
    this.cpu = process.cpuUsage();
    this.queued.clear();
    const counts = new Map<TestProject, number>();
    for (const spec of specs) {
      counts.set(spec.project, (counts.get(spec.project) ?? 0) + 1);
    }
    for (const [project, files] of counts) {
      const config = project.config;
      writeReceipt("project", {
        name: project.name,
        files,
        configuredPool: config.pool,
        maxWorkers: config.maxWorkers ?? null,
        isolate: config.isolate,
        browser: {
          enabled: config.browser.enabled,
          headless: config.browser.headless,
          fileParallelism: config.browser.fileParallelism,
          isolate: config.browser.isolate,
        },
      });
    }
  }

  onTestModuleQueued(module: TestModule) {
    this.queued.set(moduleKey(module.toTestSpecification()), performance.now() - this.started);
  }

  onTestModuleEnd(module: TestModule) {
    const spec = module.toTestSpecification();
    const key = moduleKey(spec);
    const { importDurations: _imports, ...diagnostic } = module.diagnostic();
    writeReceipt("module", {
      project: module.project.name,
      pool: spec.pool,
      file: module.relativeModuleId,
      state: module.state(),
      queuedEventAtMs: this.queued.get(key) ?? null,
      endEventAtMs: performance.now() - this.started,
      // Native environment/prepare values can repeat for reused workers;
      // retain the separate fields rather than summing them into wall time.
      diagnostic,
    });
    this.queued.delete(key);
  }

  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    writeReceipt("run", {
      reason,
      files: modules.length,
      unhandledErrors: errors.length,
      elapsedMs: performance.now() - this.started,
      // This process includes Node worker threads, not Chromium child CPU.
      processCpuMicros: process.cpuUsage(this.cpu),
    });
  }
}
