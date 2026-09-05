// Protect complete, deterministic UI E2E partitions and timing fallback precedence.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSpecification } from "vitest/node";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.ts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const timingPath = path.join(repoRoot, "config/ci-test-timings.json");
const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function useTimings(contents: string | null) {
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if ((file instanceof URL ? fileURLToPath(file) : file) === timingPath) {
      if (contents === null) {
        throw new Error("ENOENT");
      }
      return contents;
    }
    return readFileSync(file, options);
  });
  syncBuiltinESMExports();
}

function timingFile(fileSeconds: Record<string, number>, perFileOverheadSeconds = 0.6) {
  return JSON.stringify({
    version: 1,
    updatedAt: "2026-08-27",
    source: "fixture measurements",
    uiE2e: { fileSeconds, perFileOverheadSeconds },
    compactGroupSeconds: { blacksmith: {}, github: {} },
    repoE2eFileSeconds: {},
  });
}

function specifications(
  paths: string[],
  options: { name?: string; projectWorkers?: number | null; rootWorkers?: number } = {},
): TestSpecification[] {
  const project = {
    config: {
      maxWorkers: options.projectWorkers === null ? undefined : (options.projectWorkers ?? 1),
    },
    name: options.name ?? "fixture",
    vitest: { config: { maxWorkers: options.rootWorkers ?? 1 } },
  };
  return paths.map((moduleId) => ({ moduleId, project }) as TestSpecification);
}

function temporaryFiles(sizes: number[]): TestSpecification[] {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-e2e-shards-"));
  tempDirs.push(tempDir);
  return specifications(
    sizes.map((bytes, index) => {
      const moduleId = path.join(tempDir, `suite-${index}.e2e.test.ts`);
      fs.writeFileSync(moduleId, "x".repeat(bytes));
      return moduleId;
    }),
  );
}

async function partitionSpecifications(files: TestSpecification[], count = 11) {
  const { UiE2eSequencer } = await import("./vitest/vitest.ui-e2e.sequencer.ts");
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const sequencer = new UiE2eSequencer({
        config: { shard: { count, index: index + 1 } },
      } as never);
      return sequencer.shard(files);
    }),
  );
}

async function partition(files: TestSpecification[], count = 11) {
  return (await partitionSpecifications(files, count)).map((shard) =>
    shard.map((file) => file.moduleId),
  );
}

const standaloneFile = "ui/src/e2e/board-fixture.e2e.test.ts";
const bundledFile = "ui/src/e2e/mount-fallback.e2e.test.ts";
const serialBundledFile = "ui/src/e2e/chat-stream-runtime-budgets.e2e.test.ts";
const privateFile = "ui/src/e2e/approval-bootstrap.e2e.test.ts";
const qaLabFiles = [
  "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
] as const;
const realGatewayFiles = [
  "agent-file-lifecycle.real-gateway",
  "chat-loading-performance.real-gateway",
  "chat-project-media.real-gateway",
  "chat-widget-sandbox.real-gateway",
  "control-ui-auth-transports",
  "cron-duration-save.real-gateway",
  "logs-lifecycle",
  "mcp-app-conformance",
  "session-progress-hovercard.real-gateway",
  "usage-sessions-owner-attribution",
]
  .map((name) => `ui/src/e2e/${name}.e2e.test.ts`)
  .concat(qaLabFiles);
const mcpFile = "ui/src/e2e/mcp-app-conformance.e2e.test.ts";
const builtGatewayFile = "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts";

type OwnershipProbe = {
  files: Array<{
    file: string;
    project: string;
    phase: number;
    workers: number;
    fileParallelism: boolean;
  }>;
  contexts: Array<{
    name: string;
    chromium?: { available: boolean };
    url?: string | null;
    bridge: boolean;
  }>;
  leases: Array<{ outDir: string; closed: boolean; removed: boolean }>;
  shards: string[][];
  steps: Array<{ builds: number; closes: number }>;
  admissions: string[];
  rootWorkers: number;
  setupError?: string;
};

function probeOwnership(
  options: {
    prebuilt?: boolean;
    filters?: string[];
    cli?: string[];
    project?: string[];
    include?: string[];
    skipRealGateway?: boolean;
    available?: boolean;
    initialize?: string[][];
    failure?: "build" | "provide" | "admission";
  } = {},
): OwnershipProbe {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-ui-ownership-")));
  tempDirs.push(directory);
  const eventsFile = path.join(directory, "leases.jsonl");
  const admissionsFile = path.join(directory, "admissions.jsonl");
  const resourceFile = path.join(directory, "resources.mjs");
  fs.writeFileSync(
    resourceFile,
    `
    import fs from "node:fs";
    export const resolvePlaywrightChromiumExecutablePath = () => "/fixture/chromium";
    export const canRunPlaywrightChromium = () => ${options.available !== false};
    export default function admission(project) {
      fs.appendFileSync(${JSON.stringify(admissionsFile)}, JSON.stringify(project.name) + "\\n");
      if (${JSON.stringify(options.failure)} === "admission") throw new Error("fixture admission failed");
    }
    export async function startBundledControlUiE2eServer(outDir) {
      fs.writeFileSync(outDir + "/bundle.html", "fixture");
      const record = (closed) => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ outDir, closed }) + "\\n");
      record(false);
      if (${JSON.stringify(options.failure)} === "build") throw new Error("fixture build failed");
      return { baseUrl: "http://127.0.0.1:12345/", close: async () => record(true) };
    }
  `,
  );
  const configFile = path.join(directory, "config.mjs");
  fs.writeFileSync(
    configFile,
    `
    import config from ${JSON.stringify(path.join(repoRoot, `test/vitest/vitest.ui-e2e${options.prebuilt ? "-prebuilt" : ""}.config.ts`))};
    function instrument(config) {
      return { ...config, resolve: { ...config.resolve, alias: [
        { find: /^.*\\/control-ui-e2e\\.ts$/, replacement: ${JSON.stringify(resourceFile)} },
        { find: /^.*\\/vitest\\.ui-e2e-prebuilt\\.global-setup\\.ts$/, replacement: ${JSON.stringify(resourceFile)} },
        ...(config.resolve?.alias ?? []),
      ] }, test: { ...config.test,
        ...(config.test?.projects ? { projects: config.test.projects.map(instrument) } : {}),
      } };
    }
    export default instrument(config);
  `,
  );
  const includeFile = path.join(directory, "include.json");
  fs.writeFileSync(includeFile, JSON.stringify(options.include ?? []));
  // Native discovery/setup owns selection; stub only the expensive resource and admission calls.
  // The admission owner's separate tests exercise real freshness checks and teardown fingerprints.
  // No browser tests run; selected specifications still decide which projects acquire resources.
  const result = spawnNodeEvalSync(
    `
    import fs from "node:fs";
    import path from "node:path";
    import { createVitest, parseCLI } from "vitest/node";
    const filters = ${JSON.stringify(options.filters ?? [])};
    const args = ["run", ...filters, ...${JSON.stringify(options.cli ?? [])}];
    process.argv = [process.execPath, "vitest", ...args];
    const { options: cliOptions } = parseCLI(["vitest", ...args]);
    // Vitest's CLI makes --exclude additive before calling createVitest.
    const { exclude: cliExclude, ...parsedOptions } = cliOptions;
    const ctx = await createVitest("test", {
      ...parsedOptions, cliExclude,
      root: ${JSON.stringify(repoRoot)}, config: ${JSON.stringify(configFile)},
      configLoader: "runner", watch: false, project: ${JSON.stringify(options.project ?? [])},
    });
    const readEvents = () => fs.existsSync(${JSON.stringify(eventsFile)})
      ? fs.readFileSync(${JSON.stringify(eventsFile)}, "utf8").trim().split("\\n").map(JSON.parse) : [];
    if (${JSON.stringify(options.failure)} === "provide") {
      const root = ctx.getRootProject();
      const provide = root.provide;
      root.provide = (key, value) => {
        if (key === "controlUiE2eServerBaseUrl") throw new Error("fixture provide failed");
        return provide(key, value);
      };
    }
    let report;
    try {
      const specs = [];
      const steps = [];
      let setupError;
      for (const selection of ${JSON.stringify(options.initialize ?? [options.filters ?? []])}) {
        const selected = await ctx.globTestSpecifications(selection);
        specs.push(...selected.filter(spec => !specs.some(previous =>
          previous.moduleId === spec.moduleId && previous.project === spec.project)));
        try {
          await ctx.initializeGlobalSetup(selected);
          await ctx.initializeGlobalSetup(selected);
        } catch (error) { setupError = error.message; }
        const events = readEvents();
        steps.push({ builds: events.filter(event => !event.closed).length,
          closes: events.filter(event => event.closed).length });
      }
      const projects = [...new Set(specs.map(spec => spec.project))];
      const relative = file => path.relative(${JSON.stringify(repoRoot)}, file).replaceAll("\\\\", "/");
      const sequencer = new ctx.config.sequence.sequencer(ctx);
      const shards = [];
      for (let index = 1; index <= 11; index++) {
        ctx.config.shard = { index, count: 11 };
        shards.push((await sequencer.shard(specs)).map(spec => relative(spec.moduleId)));
      }
      report = {
        // Filesystem discovery order is not a contract; retain every file/project pair.
        files: specs.map(spec => ({ file: relative(spec.moduleId), project: spec.project.name,
          phase: spec.project.config.sequence.groupOrder,
          workers: spec.project.config.maxWorkers ?? ctx.config.maxWorkers,
          fileParallelism: spec.project.config.fileParallelism,
        }))
          .toSorted((a, b) => a.file.localeCompare(b.file)),
        contexts: projects.map(project => ({ name: project.name,
          chromium: project.getProvidedContext().controlUiE2eChromium,
          url: project.getProvidedContext().controlUiE2eServerBaseUrl,
          bridge: project.config.setupFiles.some(file => file.endsWith("/vitest.ui-e2e.setup.ts")),
        })), shards, steps, setupError, rootWorkers: ctx.config.maxWorkers,
        admissions: fs.existsSync(${JSON.stringify(admissionsFile)})
          ? fs.readFileSync(${JSON.stringify(admissionsFile)}, "utf8").trim().split("\\n").map(JSON.parse) : [],
      };
    } finally { await ctx.close(); }
    const events = readEvents();
    report.leases = events.filter(event => !event.closed).map(event => ({
      ...event, closed: events.filter(other => other.outDir === event.outDir && other.closed).length === 1,
      removed: !fs.existsSync(event.outDir),
    }));
    console.log("OWNERSHIP " + JSON.stringify(report));
  `,
    {
      cwd: repoRoot,
      timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        OPENCLAW_VITEST_INCLUDE_FILE: options.include ? includeFile : "",
        OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: options.skipRealGateway ? "1" : "",
      },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const report = result.stdout.split("\n").find((line) => line.startsWith("OWNERSHIP "));
  expect(report, result.stdout).toBeDefined();
  return JSON.parse(report!.slice("OWNERSHIP ".length)) as OwnershipProbe;
}

describe("Control UI E2E resource ownership", () => {
  it.each([
    { filters: [standaloneFile], files: [standaloneFile], leases: 0 },
    ...["control-ui-retained-assets", "service-worker-update"].map((name) => {
      const file = `ui/src/e2e/${name}.e2e.test.ts`;
      return { filters: [file], files: [file], leases: 0 };
    }),
    { filters: [privateFile], files: [privateFile], leases: 0 },
    { filters: [bundledFile], files: [bundledFile], leases: 1 },
    { filters: [serialBundledFile], files: [serialBundledFile], leases: 1 },
    {
      filters: [bundledFile, serialBundledFile],
      files: [bundledFile, serialBundledFile],
      leases: 1,
    },
    {
      filters: [standaloneFile, privateFile, bundledFile, serialBundledFile],
      files: [standaloneFile, privateFile, bundledFile, serialBundledFile],
      leases: 1,
    },
    { filters: [standaloneFile, bundledFile], files: [standaloneFile, bundledFile], leases: 1 },
    { filters: ["ui/src/pages/tasks"], files: ["ui/src/pages/tasks/tasks.e2e.test.ts"], leases: 1 },
    {
      include: [standaloneFile, bundledFile],
      files: [standaloneFile, bundledFile],
      leases: 1,
    },
    {
      include: [standaloneFile, bundledFile],
      filters: [standaloneFile],
      files: [standaloneFile],
      leases: 0,
    },
    {
      include: ["ui/src/e2e/**/*.test.ts"],
      filters: [standaloneFile],
      files: [standaloneFile],
      leases: 0,
    },
    {
      include: ["ui/src/e2e/**/*.test.ts"],
      files: fs.globSync("ui/src/e2e/**/*.test.ts", { cwd: repoRoot }),
      leases: 1,
    },
    { include: [], files: [], leases: 0 },
    { filters: ["ui/src/e2e/does-not-exist.e2e.test.ts"], files: [], leases: 0 },
    { filters: [bundledFile], available: false, files: [bundledFile], leases: 0 },
    { prebuilt: true, filters: [builtGatewayFile], files: [builtGatewayFile], leases: 0 },
    { prebuilt: true, filters: [mcpFile], files: [mcpFile], leases: 0 },
    { prebuilt: true, filters: [bundledFile], files: [], leases: 0 },
    { prebuilt: true, skipRealGateway: true, files: [], leases: 0 },
    {
      prebuilt: true,
      include: ["ui/src/e2e/*.real-gateway.e2e.test.ts"],
      filters: [builtGatewayFile, bundledFile],
      files: [builtGatewayFile],
      leases: 0,
    },
    {
      prebuilt: true,
      include: [mcpFile, qaLabFiles[0]],
      cli: ["--exclude", mcpFile],
      files: [qaLabFiles[0]],
      leases: 1,
    },
  ])(
    "scopes setup and leases to selection $filters / $include / $available",
    ({ files, leases, ...options }) => {
      const result = probeOwnership(options);
      expect(result.setupError).toBeUndefined();
      const compareFiles = (left: string, right: string) => left.localeCompare(right);
      expect(result.files.map((entry) => entry.file).toSorted(compareFiles)).toEqual(
        files.toSorted(compareFiles),
      );
      expect(result.leases).toHaveLength(leases);
      expect(result.leases.every((lease) => lease.closed && lease.removed)).toBe(true);
      for (const context of result.contexts) {
        expect(context.chromium?.available).toBe(options.available !== false);
        const consumesBundle = ["ui-e2e-bundled", "ui-e2e-serial", "ui-e2e-real-gateway"].includes(
          context.name,
        );
        // Root context is inherited by all projects; only consumers install the URL bridge.
        expect(context.bridge).toBe(consumesBundle);
        if (consumesBundle) {
          expect(context.url).toBe(options.available === false ? null : "http://127.0.0.1:12345/");
        }
      }
      expect(result.admissions.toSorted()).toEqual(
        options.prebuilt ? result.contexts.map((context) => context.name).toSorted() : [],
      );
    },
  );

  it.each([
    { first: bundledFile, second: serialBundledFile, available: true },
    { first: serialBundledFile, second: bundledFile, available: true },
    { first: bundledFile, second: serialBundledFile, available: false },
    { first: serialBundledFile, second: bundledFile, available: false },
  ])(
    "shares the bundle fact after standalone selection, $first then $second (Chromium: $available)",
    ({ first, second, available }) => {
      const result = probeOwnership({
        initialize: [[standaloneFile], [first], [second]],
        available,
      });
      expect(result.setupError).toBeUndefined();
      expect(result.steps).toEqual([
        { builds: 0, closes: 0 },
        { builds: available ? 1 : 0, closes: 0 },
        { builds: available ? 1 : 0, closes: 0 },
      ]);
      expect(result.leases).toEqual(
        available ? [{ outDir: expect.any(String), closed: true, removed: true }] : [],
      );
      expect(
        result.contexts.filter((context) => context.bridge).map((context) => context.url),
      ).toEqual([
        available ? "http://127.0.0.1:12345/" : null,
        available ? "http://127.0.0.1:12345/" : null,
      ]);
    },
  );

  it.each(["build", "provide"] as const)(
    "cleans the private bundle after native %s failure",
    (failure) => {
      const result = probeOwnership({ filters: [bundledFile], failure });
      expect(result.setupError).toBe(`fixture ${failure} failed`);
      expect(result.leases).toEqual([
        { outDir: expect.any(String), closed: failure === "provide", removed: true },
      ]);
    },
  );

  it("owns the complete inventory once and shards the project union without losing QA Lab or real-Gateway siblings", async () => {
    const { createUiE2eVitestConfig, uiE2ePrivateServerTestFiles, uiE2eSerialTestFiles } =
      await import("./vitest/vitest.ui-e2e.config.ts");
    const config = createUiE2eVitestConfig();
    const projects = config.test?.projects as
      | Array<{ extends?: boolean; test?: { clearMocks?: boolean } }>
      | undefined;
    expect(config.test?.clearMocks).toBe(false);
    expect(projects?.map((project) => project.extends)).toEqual([false, false, false, false]);
    expect(projects?.map((project) => project.test?.clearMocks)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const result = probeOwnership();
    const inventory = fs
      .globSync(["ui/src/**/*.e2e.test.ts", ...qaLabFiles], { cwd: repoRoot })
      .toSorted();
    expect(result.files.map((entry) => entry.file).toSorted()).toEqual(inventory);
    expect(result.setupError).toBeUndefined();
    expect(result.rootWorkers).toBeGreaterThan(0);
    expect(result.rootWorkers).toBeLessThanOrEqual(2);
    for (const entry of result.files) {
      const serial = uiE2eSerialTestFiles.includes(entry.file);
      expect(entry.project.startsWith("ui-e2e-serial")).toBe(serial);
      expect(entry.phase).toBe(serial ? 1 : 0);
      expect(entry.workers).toBe(serial ? 1 : result.rootWorkers);
      if (uiE2ePrivateServerTestFiles.includes(entry.file)) {
        expect(entry.project).toBe("ui-e2e-serial-standalone");
      }
    }
    expect(result.leases).toEqual([{ outDir: expect.any(String), closed: true, removed: true }]);
    expect(result.shards.flat().toSorted()).toEqual(inventory);
    expect(new Set(result.shards.flat()).size).toBe(inventory.length);
    for (const name of new Set(result.files.map((entry) => entry.project))) {
      const selected = probeOwnership({ project: [name] });
      expect(selected.files).toEqual(result.files.filter((entry) => entry.project === name));
      expect(selected.leases).toHaveLength(name.endsWith("standalone") ? 0 : 1);
    }
    const realGateway = realGatewayFiles;
    expect(
      result.files
        .filter((entry) => realGateway.includes(entry.file))
        .map(({ file, project }) => ({ file, project })),
    ).toEqual(
      realGateway.toSorted().map((file) => ({
        file,
        project: uiE2ePrivateServerTestFiles.includes(file)
          ? "ui-e2e-serial-standalone"
          : "ui-e2e-serial",
      })),
    );
    const skipped = probeOwnership({ skipRealGateway: true });
    expect(skipped.files).toEqual(
      result.files.filter((entry) => !realGateway.includes(entry.file)),
    );
    expect(skipped.shards.flat().toSorted()).toEqual(
      inventory.filter((file) => !realGateway.includes(file)),
    );
    expect(result.admissions).toEqual([]);
    expect(skipped.admissions).toEqual([]);
  });

  it.each([undefined, 1])(
    "admits every prebuilt real-Gateway file once with the native worker cap %s",
    (workers) => {
      const result = probeOwnership({
        prebuilt: true,
        cli: workers === undefined ? [] : ["--maxWorkers", String(workers)],
      });
      expect(result.setupError).toBeUndefined();
      expect(result.files.map((entry) => entry.file).toSorted()).toEqual(
        realGatewayFiles.toSorted(),
      );
      expect(result.shards.flat().toSorted()).toEqual(realGatewayFiles.toSorted());
      expect(new Set(result.shards.flat()).size).toBe(14);
      expect(result.rootWorkers).toBeGreaterThan(0);
      expect(result.rootWorkers).toBeLessThanOrEqual(2);
      if (workers !== undefined) {
        expect(result.rootWorkers).toBe(workers);
      }
      expect(result.files.filter((entry) => entry.phase === 1)).toEqual([
        {
          file: mcpFile,
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
      ]);
      const parallel = result.files.filter((entry) => entry.phase === 2);
      expect(parallel).toHaveLength(13);
      expect(parallel.every((entry) => entry.fileParallelism)).toBe(true);
      expect(parallel.every((entry) => entry.workers === result.rootWorkers)).toBe(true);
      expect(parallel.filter((entry) => entry.project === "ui-e2e-real-gateway")).toHaveLength(9);
      expect(
        parallel.filter((entry) => entry.project === "ui-e2e-real-gateway-standalone"),
      ).toHaveLength(4);
      expect(result.admissions.toSorted()).toEqual(
        result.contexts.map((entry) => entry.name).toSorted(),
      );
      expect(result.leases).toEqual([{ outDir: expect.any(String), closed: true, removed: true }]);
    },
  );

  it("keeps prebuilt preview acquisition lazy across native project initialization", () => {
    const result = probeOwnership({
      prebuilt: true,
      initialize: [[builtGatewayFile], [mcpFile], [qaLabFiles[0]], [qaLabFiles[1]]],
    });
    expect(result.setupError).toBeUndefined();
    expect(result.steps).toEqual([
      { builds: 0, closes: 0 },
      { builds: 0, closes: 0 },
      { builds: 1, closes: 0 },
      { builds: 1, closes: 0 },
    ]);
    expect(result.admissions).toHaveLength(3);
    expect(new Set(result.admissions).size).toBe(3);
    expect(result.leases).toEqual([{ outDir: expect.any(String), closed: true, removed: true }]);
  });

  it("propagates prebuilt admission failure before acquiring the preview", () => {
    const result = probeOwnership({
      prebuilt: true,
      filters: [qaLabFiles[0]],
      failure: "admission",
    });
    expect(result.setupError).toBe("fixture admission failed");
    expect(result.admissions).toEqual(["ui-e2e-real-gateway"]);
    expect(result.steps).toEqual([{ builds: 0, closes: 0 }]);
    expect(result.leases).toEqual([]);
    expect(result.contexts.every((context) => context.url === undefined)).toBe(true);
  });
});

describe("Control UI E2E Vitest sharding", () => {
  it("shares isolated cleanup policy with the duration weighted sequencer", async () => {
    const [{ default: config }, { UiE2eSequencer }] = await Promise.all([
      import("./vitest/vitest.ui-e2e.config.ts"),
      import("./vitest/vitest.ui-e2e.sequencer.ts"),
    ]);
    expect(config.test?.sequence?.sequencer).toBe(UiE2eSequencer);
    expect(Number.isFinite(config.test?.hookTimeout)).toBe(true);
    expect(config.test?.hookTimeout).toBeGreaterThan(0);
    for (const project of config.test?.projects ?? []) {
      expect(project).toMatchObject({
        test: {
          pool: "forks",
          isolate: true,
          runner: undefined,
          hookTimeout: config.test?.hookTimeout,
        },
      });
    }
  });

  it("balances unmeasured files by source bytes", async () => {
    useTimings(null);
    const shards = await partition(temporaryFiles([600, 500, 400, 300, 200, 100]), 3);
    expect(
      shards.map((shard) => shard.reduce((sum, file) => sum + fs.statSync(file).size, 0)),
    ).toEqual([700, 700, 700]);
  });

  it("uses repo-relative measurements before basename hints, then the byte proxy", async () => {
    const measured = "ui/src/pages/chat/chat-flow.clipboard.e2e.test.ts";
    const hinted = "ui/src/e2e/chat-flow.clipboard.e2e.test.ts";
    useTimings(timingFile({ [measured]: 1 }));
    const [large, small] = temporaryFiles([40 * 1024, 1024]);
    const files = [
      ...specifications([measured, hinted].map((file) => path.join(repoRoot, file))),
      large!,
      small!,
    ];
    const shards = await partition(files, 4);
    expect(shards).toEqual([
      [files[1]!.moduleId],
      [large!.moduleId],
      [files[0]!.moduleId],
      [small!.moduleId],
    ]);
  });

  it("charges per-file overhead so many small suites do not look free", async () => {
    useTimings(timingFile({}, 5));
    const files = temporaryFiles([10_000, 3_000, 3_000, 3_000]);
    const shards = await partition(files, 2);
    expect(shards).toEqual([
      [files[0]!.moduleId, files[3]!.moduleId],
      [files[1]!.moduleId, files[2]!.moduleId],
    ]);
  });

  it("balances both project phases by their effective worker count", async () => {
    const fixtureFiles = temporaryFiles([400, 200, 200, 100]);
    const [bundledLarge, bundledSmall, serialLarge, serialSmall] = fixtureFiles.map(
      (file) => file.moduleId,
    );
    const rawSeconds = new Map<string, number>([
      [bundledLarge!, 10],
      [bundledSmall!, 10],
      [serialLarge!, 10],
      [serialSmall!, 20],
    ]);
    useTimings(
      timingFile(
        Object.fromEntries(
          [...rawSeconds].map(([file, seconds]) => [path.relative(repoRoot, file), seconds]),
        ),
        0,
      ),
    );
    const bundled = specifications([bundledLarge!, bundledSmall!], {
      name: "ui-e2e-bundled",
      projectWorkers: null,
      rootWorkers: 2,
    });
    const serial = specifications([serialLarge!, serialSmall!], {
      name: "ui-e2e-serial",
      projectWorkers: 1,
      rootWorkers: 2,
    });
    const shards = await partitionSpecifications([...bundled, ...serial], 2);
    const workerCount = (file: TestSpecification) =>
      (file.project.config.maxWorkers ?? file.project.vitest.config.maxWorkers)!;

    expect(
      shards.map((shard) =>
        shard.reduce((sum, file) => sum + rawSeconds.get(file.moduleId)! / workerCount(file), 0),
      ),
    ).toEqual([20, 20]);
    expect(
      shards
        .flat()
        .map((file) => file.moduleId)
        .toSorted(),
    ).toEqual(fixtureFiles.map((file) => file.moduleId).toSorted());
    expect(new Set(shards.flat()).size).toBe(fixtureFiles.length);
    expect(shards.flat().filter((file) => file.project.name === "ui-e2e-serial")).toHaveLength(2);
  });

  it("assigns every discovered file once with committed timings, ignoring stale keys", async () => {
    const committed = fs.readFileSync(timingPath, "utf8");
    const discovered = fs.globSync(["ui/src/**/*.e2e.test.ts", ...qaLabFiles], { cwd: repoRoot });
    const { uiE2eSerialTestFiles } = await import("./vitest/vitest.ui-e2e.config.ts");
    const serial = new Set(uiE2eSerialTestFiles);
    const files = [
      ...specifications(
        discovered.filter((file) => !serial.has(file)).map((file) => path.join(repoRoot, file)),
        { name: "ui-e2e-bundled", projectWorkers: null, rootWorkers: 2 },
      ),
      ...specifications(
        discovered.filter((file) => serial.has(file)).map((file) => path.join(repoRoot, file)),
        { name: "ui-e2e-serial", projectWorkers: 1, rootWorkers: 2 },
      ),
    ];
    expect(files.length).toBeGreaterThan(0);
    useTimings(committed);
    const original = await partition(files);
    // Validate via the production loader before adding a stale but valid weight.
    const { readUiE2eFileTimings } = await import("../scripts/lib/ci-test-timings.mts");
    const timings = readUiE2eFileTimings();
    expect(Object.keys(timings.fileSeconds).length).toBeGreaterThan(0);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.resetModules();
    useTimings(
      timingFile(
        { ...timings.fileSeconds, "ui/src/e2e/deleted.e2e.test.ts": 9999 },
        timings.perFileOverheadSeconds,
      ),
    );
    expect(await partition(files.toReversed())).toEqual(original);
    expect(original.flat().toSorted()).toEqual(files.map((file) => file.moduleId).toSorted());
    expect(new Set(original.flat()).size).toBe(files.length);
  });

  it.each([
    ["truncated JSON", '{"version":1'],
    ["wrong version", timingFile({}).replace('"version":1', '"version":2')],
    ["negative seconds", timingFile({ "ui/src/e2e/chat-flow.clipboard.e2e.test.ts": -1 })],
  ])("preserves the no-file partition with %s", async (_name, contents) => {
    const files = specifications(
      fs
        .globSync(["ui/src/**/*.e2e.test.ts", ...qaLabFiles], { cwd: repoRoot })
        .map((file) => path.join(repoRoot, file)),
    );
    useTimings(null);
    const baseline = await partition(files);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.resetModules();
    useTimings(contents);
    const actual = await partition(files);
    expect(actual).toEqual(baseline);
    expect(actual.flat().toSorted()).toEqual(files.map((file) => file.moduleId).toSorted());
    expect(new Set(actual.flat()).size).toBe(files.length);
  });
});
