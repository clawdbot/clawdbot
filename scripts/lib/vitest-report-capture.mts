import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Reporter, TestModule, TestProject, TestSpecification, Vitest } from "vitest/node";

function projectIdentity(project: TestProject) {
  return {
    name: project.name,
    root: project.config.root,
    config: project.vite.config.configFile,
    pool: project.config.pool,
  };
}

function moduleIdentity(spec: TestSpecification) {
  return {
    ...projectIdentity(spec.project),
    file: spec.moduleId,
    pool: spec.pool,
    taskId: spec.taskId,
  };
}

// Native Istanbul reporter destinations (istanbul-reports/lib/*/index.js).
// Tuple options/custom reporters can select their own paths and need a separate contract.
const coverageFiles: Record<string, string[]> = {
  text: [],
  "text-summary": [],
  "text-lcov": [],
  teamcity: [],
  none: [],
  json: ["coverage-final.json"],
  "json-summary": ["coverage-summary.json"],
  lcov: ["lcov.info", "lcov-report/index.html"],
  lcovonly: ["lcov.info"],
  html: ["index.html"],
  "html-spa": ["index.html"],
  clover: ["clover.xml"],
  cobertura: ["cobertura-coverage.xml"],
};

export type VitestReportCapture = {
  pid: number;
  command: string[];
  root: string;
  projects: ReturnType<typeof projectIdentity>[];
  modules: ReturnType<typeof moduleIdentity>[];
  coverageDirectory: string | null;
  coverageFiles: string[];
  coverageOnFailure: boolean;
  processTimedOut: boolean;
  passWithNoTests: boolean;
  ignoreUnhandledErrors: boolean;
  ended?: { reason: string; unhandledErrors: number; failedModules: number };
};

const sorted = (values: unknown[]) => values.map((value) => JSON.stringify(value)).toSorted();

/** Observe native loading and replay; never replace reporters or reconstruct native tasks. */
export default class VitestReportCaptureReporter implements Reporter {
  private output = "";
  private capture!: VitestReportCapture;
  private expected: VitestReportCapture[];

  constructor(options: { expected?: VitestReportCapture[] } = {}) {
    this.expected = options.expected ?? [];
  }

  onInit(ctx: Vitest) {
    const output = ctx.config.outputFile;
    assert(output && typeof output === "object" && typeof output.json === "string");
    this.output = `${output.json}.capture.json`;
    for (const reporter of ctx.config.reporters) {
      if (Array.isArray(reporter) && ["json", "blob"].includes(reporter[0])) {
        assert(
          !("outputFile" in reporter[1] && reporter[1].outputFile != null) &&
            !("filterMeta" in reporter[1] && reporter[1].filterMeta != null),
          "Multi-invocation JSON cannot preserve config-owned reporter options. Run each config separately with its own native output file.",
        );
      }
    }
    const projects = ctx.projects.map(projectIdentity);
    assert(
      projects.every(
        (project, index) =>
          project.name && project.config && !ctx.projects[index]!.isBrowserEnabled(),
      ),
      "Multi-invocation JSON requires named file-based Node projects; run inline/browser configurations separately.",
    );
    const coverage = ctx.config.coverage;
    const expectedCoverage = coverage.enabled
      ? coverage.reporter.flatMap(([name, options]) => {
          assert(
            (coverage.provider === "v8" || coverage.provider === "istanbul") &&
              Object.hasOwn(coverageFiles, name) &&
              Object.keys(options).length === 0,
            "Multi-invocation JSON cannot own custom coverage providers/reporters or tuple options. Run each config separately with unique coverage destinations.",
          );
          return coverageFiles[name]!;
        })
      : [];
    this.capture = {
      pid: process.pid,
      command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
      root: ctx.config.root,
      projects,
      modules: [],
      coverageDirectory: ctx.config.coverage.enabled ? ctx.config.coverage.reportsDirectory : null,
      coverageFiles: expectedCoverage,
      coverageOnFailure: coverage.reportOnFailure,
      processTimedOut: false,
      passWithNoTests: ctx.config.passWithNoTests,
      ignoreUnhandledErrors: ctx.config.dangerouslyIgnoreUnhandledErrors,
    };
    if (this.expected.length) {
      const expectedProjects = [
        ...new Set(this.expected.flatMap((capture) => sorted(capture.projects))),
      ].toSorted();
      assert.deepEqual(sorted(projects), expectedProjects, "Native merge project identity changed");
    }
    this.writeCapture();
  }

  onTestRunStart(specs: readonly TestSpecification[]) {
    if (this.expected.length) {
      assert.deepEqual(
        sorted(specs.map(moduleIdentity)),
        sorted(this.expected.flatMap((capture) => capture.modules)),
        "Native merge module/project/root/pool attribution changed",
      );
    }
  }

  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    this.capture.modules = modules.map((module) => moduleIdentity(module.toTestSpecification()));
    this.capture.ended = {
      reason,
      unhandledErrors: errors.length,
      failedModules: modules.filter((module) => !module.ok()).length,
    };
    this.writeCapture();
  }

  onProcessTimeout() {
    this.capture.processTimedOut = true;
    this.writeCapture();
  }

  private writeCapture() {
    fs.mkdirSync(path.dirname(this.output), { recursive: true });
    fs.writeFileSync(this.output, JSON.stringify(this.capture));
  }
}
