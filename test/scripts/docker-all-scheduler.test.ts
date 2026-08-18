// Docker All Scheduler tests cover docker all scheduler script behavior.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_LIVE_RETRIES,
  DEFAULT_RESOURCE_LIMITS,
  resolveDockerE2ePlan,
} from "../../scripts/lib/docker-e2e-plan.mts";
import {
  appendBoundedShellCapture,
  buildLaneRerunCommand,
  canStartSchedulerLane,
  describeDockerSchedulerLimits,
  dockerPreflightContainerNames,
  dockerPreflightSmokeCommand,
  githubWorkflowRerunCommand,
  LOG_TAIL_MAX_BYTES,
  parseDockerAllCliArgs,
  preparePrepublishPluginRegistry,
  resolveDockerPreflightPlatform,
  runCleanupSmokePhase,
  runShellCaptureCommand,
  runShellCommand,
  SHELL_CAPTURE_MAX_CHARS,
  tailFile,
  validateDockerCandidateEnvironment,
  writeRunSummary,
} from "../../scripts/test-docker-all.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createPrepublishPluginRegistryArtifact } = vi.hoisted(() => ({
  createPrepublishPluginRegistryArtifact: vi.fn(),
}));
vi.mock("../../scripts/prepublish-plugin-registry-artifact.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  createPrepublishPluginRegistryArtifact,
}));

const limits = {
  resourceLimits: {
    docker: 2,
    npm: 2,
  },
  weightLimit: 2,
};
const posixIt = process.platform === "win32" ? it.skip : it;
const { createTempDir } = createScriptTestHarness();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
type DockerCandidatePlan = Parameters<typeof validateDockerCandidateEnvironment>[1];

function candidatePlan({
  needsPackage = true,
  requiredPackages = [],
}: {
  needsPackage?: boolean;
  requiredPackages?: string[];
} = {}): DockerCandidatePlan {
  return {
    chunk: undefined,
    credentials: [],
    imageKinds: [],
    includeOpenWebUI: false,
    lanes: [],
    mainLanes: [],
    needs: {
      bareImage: false,
      e2eImage: needsPackage,
      functionalImage: false,
      liveImage: false,
      package: needsPackage,
      prepublishPluginRegistry: requiredPackages.length > 0,
    },
    omittedUnsupportedLanes: [],
    profile: "all",
    releaseProfile: "full",
    requiredPrepublishPluginPackages: requiredPackages,
    selectedLanes: [],
    tailLanes: [],
    version: 1,
  };
}

function writeFrozenScenarioContract(root: string, scenarios: string[]): string {
  const assertionsFile = path.join(root, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
  mkdirSync(path.dirname(assertionsFile), { recursive: true });
  writeFileSync(
    assertionsFile,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(scenarios)}\n`)});\n`,
  );
  return assertionsFile;
}

function expectDeclaredDispatchInputs(command: string): void {
  const workflow = parse(readFileSync(LIVE_E2E_WORKFLOW, "utf8")) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  };
  const declared = new Set(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {}));
  const emitted = [...command.matchAll(/(?:^|\s)-f\s+([a-z0-9_]+)=/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  expect(emitted.length).toBeGreaterThan(0);
  for (const input of emitted) {
    expect(declared.has(input), `undeclared workflow_dispatch input: ${input}`).toBe(true);
  }
}

function activePool({
  count = 0,
  resources = {},
  weight = 0,
}: {
  count?: number;
  resources?: Record<string, number>;
  weight?: number;
} = {}) {
  return {
    count,
    resources: new Map(Object.entries(resources)),
    weight,
  };
}

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writePackageTarball(
  root: string,
  name: string,
  version: string,
  fileName = "openclaw.tgz",
) {
  const packageRoot = path.join(root, `package-${fileName}`);
  const packageDir = path.join(packageRoot, "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version }));
  const tarball = path.join(root, fileName);
  execFileSync("tar", ["-czf", tarball, "-C", packageRoot, "package"]);
  return tarball;
}

function candidateFixture(packageName = "openclaw", packageVersion = "2026.8.1") {
  const root = tempDirs.make("openclaw-docker-candidate-");
  const version = "2026.8.1";
  const packagePath = writePackageTarball(
    tempDirs.make("openclaw-docker-package-"),
    packageName,
    packageVersion,
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version,
      scripts: { "test:docker:gateway-network": "true" },
    }),
  );
  writeFakePackScript(root, packagePath);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "package.json", "scripts/package-openclaw-for-docker.mjs"], {
    cwd: root,
  });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return {
    root,
    sourceSha,
    version,
    packagePath,
    env: {
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: sourceSha,
      OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
      OPENCLAW_CURRENT_PACKAGE_VERSION: version,
      OPENCLAW_CURRENT_PACKAGE_SHA256: sha256(packagePath),
    },
  };
}

function writeFakePackScript(root: string, sourceTarball: string) {
  const script = path.join(root, "scripts/package-openclaw-for-docker.mjs");
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(
    script,
    `import fs from "node:fs"; import path from "node:path";
const outputDir = process.argv[process.argv.indexOf("--output-dir") + 1];
const outputName = process.argv[process.argv.indexOf("--output-name") + 1];
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(${JSON.stringify(sourceTarball)}, path.join(outputDir, outputName));\n`,
  );
}

function runCandidatePrep(fixture: ReturnType<typeof candidateFixture>) {
  const manifestPath = path.join(fixture.root, "candidate.json");
  const result = spawnSync(
    process.execPath,
    ["scripts/test-docker-all.mjs", `--prepare-only=${manifestPath}`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_LANES: "gateway-network",
        OPENCLAW_DOCKER_ALL_LOG_DIR: path.join(fixture.root, "logs"),
        OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        OPENCLAW_DOCKER_E2E_REPO_ROOT: fixture.root,
      },
    },
  );
  return { manifestPath, result };
}

function addRegistry(
  fixture: ReturnType<typeof candidateFixture>,
  packageNames = ["@openclaw/discord", "@openclaw/feishu"],
) {
  const registryDir = path.join(fixture.root, "registry");
  mkdirSync(registryDir);
  const packages = packageNames.toSorted().map((name, index) => {
    const tarball = `plugin-${String(index)}.tgz`;
    const tarballPath = path.join(registryDir, tarball);
    copyFileSync(writePackageTarball(fixture.root, name, fixture.version, tarball), tarballPath);
    return { name, version: fixture.version, tarball, sha256: sha256(tarballPath) };
  });
  const manifestPath = path.join(registryDir, "prepublish-plugin-registry.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schema: "openclaw.prepublish-plugin-registry/v1",
        schemaVersion: 1,
        sourceSha: fixture.sourceSha,
        candidateVersion: fixture.version,
        packages,
      },
      null,
      2,
    )}\n`,
  );
  return {
    ...fixture.env,
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: fixture.version,
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: sha256(manifestPath),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readCompletePidFile(pidPath: string): number | undefined {
  if (!existsSync(pidPath)) {
    return undefined;
  }
  const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
  return Number.isInteger(pid) ? pid : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error("condition was not met before timeout");
}

async function waitForChildClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("child did not close before timeout"));
      }, timeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );
}

describe("scripts/test-docker-all scheduler", () => {
  it("parses the supported CLI options", () => {
    expect(parseDockerAllCliArgs([])).toEqual({
      help: false,
      planJson: false,
      preparePluginRegistry: false,
    });
    expect(parseDockerAllCliArgs(["--plan-json"])).toEqual({
      help: false,
      planJson: true,
      preparePluginRegistry: false,
    });
    expect(parseDockerAllCliArgs(["--help"])).toEqual({
      help: true,
      planJson: false,
      preparePluginRegistry: false,
    });
    expect(parseDockerAllCliArgs(["--prepare-only=/tmp/candidate.json"])).toEqual({
      help: false,
      planJson: false,
      prepareOnly: "/tmp/candidate.json",
      preparePluginRegistry: false,
    });
    expect(parseDockerAllCliArgs(["--prepare-plugin-registry"])).toEqual({
      help: false,
      planJson: false,
      preparePluginRegistry: true,
    });
    expect(() =>
      parseDockerAllCliArgs(["--plan-json", "--prepare-only=/tmp/candidate.json"]),
    ).toThrow("conflicting plan/prep options");
    expect(() =>
      parseDockerAllCliArgs(["--prepare-only=/tmp/candidate.json", "--prepare-plugin-registry"]),
    ).toThrow("conflicting plan/prep options");
  });

  it("prints CLI help without a stack trace", () => {
    const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--prepare-only=<manifest>");
    expect(result.stdout).toContain("--prepare-plugin-registry");
    expect(result.stdout).toContain("OPENCLAW_DOCKER_ALL_* env vars");
  });

  it("passes the exact planner-selected survivor packages to registry preparation", () => {
    const root = tempDirs.make("openclaw-standalone-survivor-registry-");
    const plan = resolveDockerE2ePlan({
      allowFrozenTargetScenarioOmissions: true,
      includeOpenWebUI: false,
      liveMode: "all",
      liveRetries: DEFAULT_LIVE_RETRIES,
      orderLanes: <T>(lanes: T[]) => lanes,
      planReleaseAll: false,
      profile: "all",
      releaseChunk: "core",
      selectedLaneNames: ["published-upgrade-survivor"],
      timingStore: undefined,
      upgradeSurvivorBaselines: "openclaw@2026.7.1-2",
      upgradeSurvivorScenarios: "configured-plugin-installs",
    }).plan;
    createPrepublishPluginRegistryArtifact.mockReturnValue({
      manifestSha256: "b".repeat(64),
    });

    const registry = preparePrepublishPluginRegistry(plan, root, "a".repeat(40), "2026.8.1");

    expect(createPrepublishPluginRegistryArtifact).toHaveBeenCalledWith({
      candidateVersion: "2026.8.1",
      outputDir: path.join(root, "prepublish-plugin-registry"),
      repoRoot: process.cwd(),
      requiredPackages: [
        "@openclaw/codex",
        "@openclaw/discord",
        "@openclaw/matrix",
        "@openclaw/whatsapp",
      ],
      sourceSha: "a".repeat(40),
    });
    expect(registry).toEqual({
      candidateVersion: "2026.8.1",
      dir: path.join(root, "prepublish-plugin-registry"),
      manifestSha256: "b".repeat(64),
    });
  });

  it("rejects unknown CLI options without a stack trace", () => {
    const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs", "--bogus"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain("--prepare-only=<manifest>");
    expect(result.stderr).not.toContain("at ");
  });

  it("writes a package-free prep-only manifest without Docker work", () => {
    const root = tempDirs.make("openclaw-docker-package-free-");
    const manifestPath = path.join(root, "candidate.json");
    const result = spawnSync(
      process.execPath,
      ["scripts/test-docker-all.mjs", `--prepare-only=${manifestPath}`],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_ALL_LANES: "live-gateway",
          OPENCLAW_DOCKER_ALL_LOG_DIR: path.join(root, "logs"),
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      candidate: null,
    });
    expect(result.stdout).not.toContain("Docker preflight");
    expect(result.stdout).not.toContain("Build shared Docker images");
  });

  it("prepares one immutable package candidate before Docker work and rejects dirty source", () => {
    const fixture = candidateFixture();
    const { manifestPath, result } = runCandidatePrep(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      sourceSha: fixture.sourceSha,
      candidate: {
        package: {
          name: "openclaw",
          version: fixture.version,
          sha256: sha256(fixture.packagePath),
        },
        registry: null,
      },
    });
    expect(result.stdout).not.toContain("Docker preflight");
    expect(result.stdout).not.toContain("Build shared Docker images");

    writeFileSync(
      path.join(fixture.root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "dirty",
        scripts: { "test:docker:gateway-network": "true" },
      }),
    );
    const dirty = runCandidatePrep(fixture).result;
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("working-tree changes");
  });

  it("rejects untracked source before package preparation", () => {
    const fixture = candidateFixture();
    writeFileSync(path.join(fixture.root, "untracked-source.ts"), "export {};\n");
    const result = runCandidatePrep(fixture).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working-tree changes");
  });

  it.each([
    { name: "wrong-name", packageName: "not-openclaw", version: "2026.8.1" },
    { name: "wrong-version", packageName: "openclaw", version: "0.0.0" },
  ])("rejects a $name packed candidate", ({ packageName, version }) => {
    const fixture = candidateFixture(packageName, version);
    const result = runCandidatePrep(fixture).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("name or version");
  });

  it("validates complete candidate fields against HEAD and tarball bytes", () => {
    const fixture = candidateFixture();
    const plan = candidatePlan();
    expect(() => validateDockerCandidateEnvironment({}, plan, fixture.root)).not.toThrow();
    expect(() => validateDockerCandidateEnvironment(fixture.env, plan, fixture.root)).not.toThrow();
    expect(() =>
      validateDockerCandidateEnvironment(
        { OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.packagePath },
        plan,
        fixture.root,
      ),
    ).not.toThrow();
    for (const field of [
      "OPENCLAW_CURRENT_PACKAGE_VERSION",
      "OPENCLAW_CURRENT_PACKAGE_SHA256",
    ] as const) {
      const env: NodeJS.ProcessEnv = { ...fixture.env };
      delete env[field];
      expect(() => validateDockerCandidateEnvironment(env, plan, fixture.root)).toThrow(
        "must be complete",
      );
    }
    for (const env of [
      { ...fixture.env, OPENCLAW_CURRENT_PACKAGE_TGZ: "relative.tgz" },
      { ...fixture.env, OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40) },
      { ...fixture.env, OPENCLAW_CURRENT_PACKAGE_SHA256: "b".repeat(64) },
      { ...fixture.env, OPENCLAW_CURRENT_PACKAGE_VERSION: "0.0.0" },
    ]) {
      expect(() => validateDockerCandidateEnvironment(env, plan, fixture.root)).toThrow();
    }
  });

  it("preserves legacy release package and registry inputs", () => {
    const fixture = candidateFixture();
    const registryDir = path.join(fixture.root, "registry");
    const env: NodeJS.ProcessEnv = addRegistry(fixture);
    delete env.OPENCLAW_CURRENT_PACKAGE_VERSION;
    delete env.OPENCLAW_CURRENT_PACKAGE_SHA256;
    env.OPENCLAW_CURRENT_PACKAGE_TGZ = path.relative(process.cwd(), fixture.packagePath);
    env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR = path.relative(process.cwd(), registryDir);

    expect(() =>
      validateDockerCandidateEnvironment(
        env,
        candidatePlan({ requiredPackages: ["@openclaw/discord"] }),
        fixture.root,
      ),
    ).not.toThrow();
    expect(env.OPENCLAW_CURRENT_PACKAGE_TGZ).toBe(fixture.packagePath);
    expect(env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR).toBe(registryDir);
  });

  it("does not inspect package files for package-free plans", () => {
    const fixture = candidateFixture();
    expect(() =>
      validateDockerCandidateEnvironment(
        { ...fixture.env, OPENCLAW_CURRENT_PACKAGE_TGZ: path.join(fixture.root, "missing.tgz") },
        candidatePlan({ needsPackage: false }),
        fixture.root,
      ),
    ).not.toThrow();
  });

  it("validates complete registry tuples as plan-specific subsets", () => {
    const fixture = candidateFixture();
    const env = addRegistry(fixture);
    expect(() =>
      validateDockerCandidateEnvironment(
        env,
        candidatePlan({ requiredPackages: ["@openclaw/discord"] }),
        fixture.root,
      ),
    ).not.toThrow();
    expect(() =>
      validateDockerCandidateEnvironment(env, candidatePlan(), fixture.root),
    ).not.toThrow();
    expect(() =>
      validateDockerCandidateEnvironment(
        fixture.env,
        candidatePlan({ requiredPackages: ["@openclaw/discord"] }),
        fixture.root,
      ),
    ).toThrow("requires a prepublish plugin registry tuple");
    expect(() =>
      validateDockerCandidateEnvironment(
        { ...fixture.env, OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "/tmp/partial" },
        candidatePlan(),
        fixture.root,
      ),
    ).toThrow("must be complete");
    writeFileSync(path.join(env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR, "extra"), "extra");
    expect(() => validateDockerCandidateEnvironment(env, candidatePlan(), fixture.root)).toThrow(
      "missing, extra, or non-file",
    );
  });

  it("serializes complete candidate and registry tuples in lane reruns", () => {
    const fixture = candidateFixture();
    const env = addRegistry(fixture);
    const command = buildLaneRerunCommand("gateway-network", env);
    for (const key of [
      "OPENCLAW_DOCKER_E2E_SELECTED_SHA",
      "OPENCLAW_CURRENT_PACKAGE_TGZ",
      "OPENCLAW_CURRENT_PACKAGE_VERSION",
      "OPENCLAW_CURRENT_PACKAGE_SHA256",
      "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR",
      "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION",
      "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256",
    ] as const) {
      expect(command).toContain(`${key}='${env[key]}'`);
    }
  });

  it("plans from an isolated release harness with source-checkout TypeScript support", () => {
    const artifactRoot = path.resolve(".artifacts");
    mkdirSync(artifactRoot, { recursive: true });
    const root = tempDirs.make("openclaw-docker-plan-isolated-harness-", artifactRoot);
    const scriptsDir = path.join(root, "scripts");
    const libDir = path.join(scriptsDir, "lib");
    const upgradeSurvivorDir = path.join(scriptsDir, "e2e/lib/upgrade-survivor");
    mkdirSync(libDir, { recursive: true });
    mkdirSync(upgradeSurvivorDir, { recursive: true });
    copyFileSync("package.json", path.join(root, "package.json"));
    copyFileSync("scripts/test-docker-all.mjs", path.join(scriptsDir, "test-docker-all.mjs"));
    copyFileSync("scripts/test-docker-all.mts", path.join(scriptsDir, "test-docker-all.mts"));
    copyFileSync("scripts/lib/tsx-cli-shim.mjs", path.join(libDir, "tsx-cli-shim.mjs"));
    copyFileSync(
      "scripts/prepublish-plugin-registry-artifact.mjs",
      path.join(scriptsDir, "prepublish-plugin-registry-artifact.mjs"),
    );
    copyFileSync(
      "scripts/windows-cmd-helpers.mjs",
      path.join(scriptsDir, "windows-cmd-helpers.mjs"),
    );
    for (const fileName of [
      "docker-e2e-plan.mts",
      "docker-e2e-scenarios.mts",
      "official-external-channel-catalog.json",
      "release-version.mjs",
      "sleep.mjs",
    ]) {
      copyFileSync(path.join("scripts/lib", fileName), path.join(libDir, fileName));
    }
    copyFileSync(
      "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
      path.join(upgradeSurvivorDir, "config-recipe.mts"),
    );
    cpSync(
      "scripts/e2e/lib/upgrade-survivor/config-recipe",
      path.join(upgradeSurvivorDir, "config-recipe"),
      { recursive: true },
    );

    const result = spawnSync(
      process.execPath,
      [path.join(scriptsDir, "test-docker-all.mjs"), "--plan-json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_ALL_PLAN_RELEASE_ALL: "1",
          OPENCLAW_DOCKER_ALL_PROFILE: "release-path",
          OPENCLAW_UPGRADE_SURVIVOR_TARGET_ROOT: process.cwd(),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ profile: "release-path" });
  });

  it("rejects loose numeric runner env vars without a stack trace", () => {
    const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs", "--plan-json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_PARALLELISM: "1e3",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENCLAW_DOCKER_ALL_PARALLELISM must be a positive integer");
    expect(result.stderr).not.toContain("at ");
  });

  it("selects the CLI installer distribution lane through the scheduler catalog", () => {
    const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_BUILD: "0",
        OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
        OPENCLAW_DOCKER_ALL_LANES: "cli-installer-distribution",
        OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
        OPENCLAW_DOCKER_ALL_TIMINGS: "0",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Selected lanes: cli-installer-distribution");
    expect(result.stdout).toContain(
      "cli-installer-distribution(w=3 r=docker,npm timeout=1800s image=bare state=empty)",
    );
    expect(result.stdout).toContain("Dry run complete");
  });

  it("reuses only registry-backed images in generated workflow reruns", () => {
    const localCommand = githubWorkflowRerunCommand(["install-e2e"], "a".repeat(40), {
      GITHUB_REF_NAME: "full-release-validation-temp-deleted",
      GITHUB_RUN_ID: "12345",
      OPENCLAW_DOCKER_E2E_BARE_IMAGE: "openclaw-docker-e2e-bare:local",
      OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE: "openclaw-docker-e2e-functional:local",
      OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME: "docker-e2e-package",
    });
    expect(localCommand).not.toContain("--ref 'full-release-validation-temp-deleted'");
    expect(localCommand).not.toContain("package_artifact_run_id=");
    expect(localCommand).not.toContain("package_artifact_name=");
    expect(localCommand).not.toContain("docker_e2e_bare_image=");
    expect(localCommand).not.toContain("docker_e2e_functional_image=");
    expect(localCommand).not.toContain("shared_image_policy=existing-only");
    expectDeclaredDispatchInputs(localCommand);

    const registryCommand = githubWorkflowRerunCommand(["install-e2e"], "b".repeat(40), {
      OPENCLAW_DOCKER_E2E_BARE_IMAGE: "ghcr.io/openclaw/openclaw-docker-e2e-bare:test",
      OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE: "ghcr.io/openclaw/openclaw-docker-e2e-functional:test",
      OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG: "true",
      OPENCLAW_DOCKER_E2E_WORKFLOW_REF: "main",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.5.3",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "openclaw@2026.5.3 openclaw@2026.5.2",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "plugin-dependency-cleanup",
    });
    expect(registryCommand).toContain("--ref 'main'");
    expect(registryCommand).toContain(
      "docker_e2e_bare_image='ghcr.io/openclaw/openclaw-docker-e2e-bare:test'",
    );
    expect(registryCommand).toContain(
      "docker_e2e_functional_image='ghcr.io/openclaw/openclaw-docker-e2e-functional:test'",
    );
    expect(registryCommand).toContain("shared_image_policy=existing-only");
    expect(registryCommand).toContain("allow_unreleased_changelog=true");
    expectDeclaredDispatchInputs(registryCommand);
  });

  it("preserves ephemeral package intent in generated summary and failure reruns", async () => {
    const logDir = createTempDir("openclaw-docker-all-rerun-intent-");
    try {
      const selectedSha = "c".repeat(40);
      await writeRunSummary(
        logDir,
        {
          failures: [{ name: "install-e2e", status: 1 }],
          lanes: [],
          status: "failed",
        },
        {
          ...process.env,
          OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG: "true",
          OPENCLAW_DOCKER_E2E_SELECTED_SHA: selectedSha,
        },
      );

      const summaryFile = path.join(logDir, "summary.json");
      const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
      expect(summary.allowUnreleasedChangelog).toBe(true);

      const failureIndexFile = path.join(logDir, "failures.json");
      const failureIndex = JSON.parse(readFileSync(failureIndexFile, "utf8"));
      expect(failureIndex.combinedGhWorkflowCommand).toContain("allow_unreleased_changelog=true");

      for (const artifact of [summaryFile, failureIndexFile]) {
        const rerun = spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/docker-e2e-rerun.mts", artifact],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: process.env,
          },
        );
        expect(rerun.status, rerun.stderr).toBe(0);
        expect(rerun.stdout).toContain(`-f ref='${selectedSha}'`);
        expect(rerun.stdout).toContain("allow_unreleased_changelog=true");
      }
    } finally {
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  it("rejects loose numeric resource limit env vars before scheduling lanes", () => {
    const logDir = mkdtempSync(`${tmpdir()}/openclaw-docker-all-`);
    try {
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_ALL_BUILD: "0",
          OPENCLAW_DOCKER_ALL_DOCKER_LIMIT: "1e3",
          OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
          OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
          OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "OPENCLAW_DOCKER_ALL_DOCKER_LIMIT must be a positive integer",
      );
      expect(result.stderr).not.toContain("at ");
    } finally {
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  it("rejects release-path configs that schedule zero Docker lanes", () => {
    const logDir = mkdtempSync(`${tmpdir()}/openclaw-docker-all-`);
    try {
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_ALL_CHUNK: "openwebui",
          OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
          OPENCLAW_DOCKER_ALL_INCLUDE_OPENWEBUI: "0",
          OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
          OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
          OPENCLAW_DOCKER_ALL_PROFILE: "release-path",
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("Dry run complete");
      expect(result.stderr).toContain("resolved zero Docker lanes");
      expect(result.stderr).toContain("profile=release-path");
      expect(result.stderr).toContain("releaseChunk=openwebui");
      expect(result.stderr).toContain("includeOpenWebUI=0");
      expect(result.stderr).not.toContain("at ");
    } finally {
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  it("rejects candidate-controlled survivor omissions without trusted opt-in", () => {
    const root = tempDirs.make("openclaw-docker-all-untrusted-filter-");
    try {
      const assertionsFile = writeFrozenScenarioContract(root, ["unrelated"]);
      const executionMarker = path.join(root, "candidate-contract-executed");
      writeFileSync(
        assertionsFile,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(executionMarker)}, "executed");`,
          'process.stdout.write("[\\"unrelated\\"]\\n");',
        ].join("\n"),
      );
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0",
          OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
          OPENCLAW_DOCKER_ALL_LANES: "published-upgrade-survivor",
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
          OPENCLAW_UPGRADE_SURVIVOR_TARGET_ROOT: root,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("require trusted workflow opt-in");
      expect(result.stdout).not.toContain("Dry run complete");
      expect(existsSync(executionMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails with truthful artifacts when a frozen target cannot run selected survivor lanes", () => {
    const root = tempDirs.make("openclaw-docker-all-filtered-");
    const logDir = path.join(root, "logs");
    try {
      writeFrozenScenarioContract(root, ["unrelated"]);
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_DOCKER_ALL_BUILD: "0",
          OPENCLAW_DOCKER_ALL_LANES: "published-upgrade-survivor",
          OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "reported-issues",
          OPENCLAW_UPGRADE_SURVIVOR_TARGET_ROOT: root,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Docker lanes omitted");
      expect(result.stderr).toContain("resolved zero runnable Docker lanes");
      expect(result.stderr).toContain("published-upgrade-survivor");
      const summary = JSON.parse(readFileSync(path.join(logDir, "summary.json"), "utf8"));
      expect(summary.status).toBe("failed");
      expect(summary.lanes).toEqual([]);
      expect(summary.omittedUnsupportedLanes).toHaveLength(12);
      expect(summary.omittedUnsupportedLanes).toContain("published-upgrade-survivor");
      expect(summary.omittedUnsupportedLanes).toContain(
        "published-upgrade-survivor-versioned-runtime-deps",
      );
      const failures = JSON.parse(readFileSync(path.join(logDir, "failures.json"), "utf8"));
      expect(failures.status).toBe("failed");
      expect(failures.lanes).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    { args: ["--plan-json"], dryRun: false, label: "JSON planning" },
    { args: [], dryRun: true, label: "dry runs" },
  ])("preserves $label when frozen survivor lanes are omitted", ({ args, dryRun }) => {
    const root = tempDirs.make("openclaw-docker-all-filtered-plan-");
    const logDir = path.join(root, "logs");
    try {
      writeFrozenScenarioContract(root, ["unrelated"]);
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs", ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_DOCKER_ALL_BUILD: "0",
          OPENCLAW_DOCKER_ALL_DRY_RUN: dryRun ? "1" : "0",
          OPENCLAW_DOCKER_ALL_LANES: "published-upgrade-survivor",
          OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "reported-issues",
          OPENCLAW_UPGRADE_SURVIVOR_TARGET_ROOT: root,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      if (dryRun) {
        expect(result.stdout).toContain("Docker lanes omitted");
        expect(result.stdout).toContain("Dry run complete");
      } else {
        const plan = JSON.parse(result.stdout);
        expect(plan.lanes).toEqual([]);
        expect(plan.omittedUnsupportedLanes).toHaveLength(12);
      }
      expect(existsSync(path.join(logDir, "summary.json"))).toBe(false);
      expect(existsSync(path.join(logDir, "failures.json"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports omitted frozen-target lanes when another selected lane remains runnable", () => {
    const root = tempDirs.make("openclaw-docker-all-mixed-filtered-");
    try {
      writeFrozenScenarioContract(root, ["unrelated"]);
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
          OPENCLAW_DOCKER_ALL_LANES: "published-upgrade-survivor,plugin-binding-command-escape",
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "reported-issues",
          OPENCLAW_UPGRADE_SURVIVOR_TARGET_ROOT: root,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Docker lanes omitted");
      expect(result.stdout).toContain("published-upgrade-survivor");
      expect(result.stdout).toContain("plugin-binding-command-escape");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt("writes Docker run artifacts when cleanup smoke fails", async () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-all-cleanup-`);
    const logDir = path.join(root, "logs");
    const fakePnpm = path.join(root, "pnpm");
    const phases: Array<Record<string, unknown>> = [];
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env node
const command = process.argv.slice(2).join(" ");
if (command === "test:docker:cleanup") {
  console.error("cleanup smoke failed intentionally");
  process.exit(42);
}
process.exit(0);
`,
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);

    try {
      const baseEnv = {
        ...process.env,
        OPENCLAW_DOCKER_E2E_IMAGE: "openclaw-test-image",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const cleanupFailure = await runCleanupSmokePhase(baseEnv, logDir, phases);
      expect(cleanupFailure).toMatchObject({ name: "cleanup-smoke", status: 42 });
      if (!cleanupFailure) {
        throw new Error("expected cleanup smoke failure");
      }
      await writeRunSummary(logDir, {
        failures: [cleanupFailure],
        image: baseEnv.OPENCLAW_DOCKER_E2E_IMAGE,
        images: {
          bare: "openclaw-test-bare",
          functional: "openclaw-test-image",
        },
        lanes: [],
        phases,
        profile: "local",
        startedAt: new Date().toISOString(),
        status: "failed",
      });

      const summary = JSON.parse(readFileSync(path.join(logDir, "summary.json"), "utf8"));
      expect(summary.status).toBe("failed");
      expect(summary.failures).toHaveLength(1);
      expect(summary.failures[0]).toMatchObject({
        name: "cleanup-smoke",
        rerunCommand: "pnpm test:docker:cleanup",
        status: 42,
        targetable: false,
      });
      expect(summary.lanes.some((lane: { name?: string }) => lane.name === "cleanup-smoke")).toBe(
        false,
      );
      expect(summary.phases.at(-1)).toMatchObject({
        name: "cleanup-smoke",
        status: "failed",
      });

      const failureIndex = JSON.parse(readFileSync(path.join(logDir, "failures.json"), "utf8"));
      expect(failureIndex.status).toBe("failed");
      expect(failureIndex.combinedGhWorkflowCommand).toBeUndefined();
      expect(failureIndex.lanes[0]?.ghWorkflowCommand).toBeUndefined();
      expect(failureIndex.lanes).toEqual([
        expect.objectContaining({
          lane: "cleanup-smoke",
          rerunCommand: "pnpm test:docker:cleanup",
          status: 42,
          targetable: false,
        }),
      ]);
      const cleanupLog = readFileSync(path.join(logDir, "cleanup-smoke.log"), "utf8");
      expect(cleanupLog).toContain("cleanup smoke failed intentionally");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("allows an overweight lane to start alone under low parallelism", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "install-e2e",
          resources: ["npm"],
          weight: 4,
        },
        activePool(),
        2,
        limits,
      ),
    ).toBe(true);
  });

  it("does not co-schedule another lane while an overweight lane is active", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "package-update",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 1,
          resources: {
            docker: 4,
            npm: 4,
          },
          weight: 4,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("can co-schedule the split installer provider lanes", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "install-e2e-anthropic",
          resources: ["npm", "service"],
          weight: 3,
        },
        activePool({
          count: 1,
          resources: {
            docker: 3,
            npm: 3,
            service: 3,
          },
          weight: 3,
        }),
        10,
        {
          resourceLimits: {
            docker: 10,
            npm: 10,
            service: 7,
          },
          weightLimit: 10,
        },
      ),
    ).toBe(true);
  });

  it("preserves the parallelism count cap", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "package-update",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 2,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("keeps resource and weight limits as co-scheduling limits", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "npm-smoke",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 1,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(true);

    expect(
      canStartSchedulerLane(
        {
          name: "npm-heavy",
          resources: ["npm"],
          weight: 2,
        },
        activePool({
          count: 1,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("serializes live OpenAI Docker lanes by default", () => {
    expect(DEFAULT_RESOURCE_LIMITS["live:openai"]).toBe(1);
  });

  it("caps npm-heavy Docker lanes below full parallelism by default", () => {
    expect(DEFAULT_RESOURCE_LIMITS.npm).toBe(5);
  });

  it("cleans stale stopped containers from all named Docker E2E lanes", () => {
    expect(
      dockerPreflightContainerNames(`
openclaw-gateway-e2e-123 Exited (1) 2 minutes ago
openclaw-config-reload-e2e-234 Created
openclaw-plugin-binding-command-escape-e2e-345 Dead
openclaw-kitchen-sink-rpc-e2e-456 Exited (137) 10 seconds ago
openclaw-openwebui-gateway-567 Exited (1) 3 minutes ago
openclaw-openwebui-678 Created
openclaw-not-an-e2e-container Exited (1) 2 minutes ago
postgres Created
`),
    ).toEqual([
      "openclaw-gateway-e2e-123",
      "openclaw-config-reload-e2e-234",
      "openclaw-plugin-binding-command-escape-e2e-345",
      "openclaw-kitchen-sink-rpc-e2e-456",
      "openclaw-openwebui-gateway-567",
      "openclaw-openwebui-678",
    ]);
  });

  it("pins Docker preflight smoke to the native platform", () => {
    expect(resolveDockerPreflightPlatform("x64")).toBe("linux/amd64");
    expect(resolveDockerPreflightPlatform("arm64")).toBe("linux/arm64");
    expect(dockerPreflightSmokeCommand("x64")).toBe(
      "docker run --rm --platform 'linux/amd64' alpine:3.20 true",
    );
    expect(dockerPreflightSmokeCommand("arm64")).toBe(
      "docker run --rm --platform 'linux/arm64' alpine:3.20 true",
    );
  });

  it("bounds captured preflight command output while keeping the newest tail", () => {
    const first = appendBoundedShellCapture("abc", "def", 8);
    expect(first).toEqual({ text: "abcdef", truncated: false });

    const second = appendBoundedShellCapture(first.text, "ghijkl", 8);
    expect(second).toEqual({ text: "efghijkl", truncated: true });
    expect(SHELL_CAPTURE_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("reads bounded lane log tails instead of full noisy logs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-docker-all-log-tail-"));
    try {
      const logPath = path.join(root, "lane.log");
      writeFileSync(
        logPath,
        `old-secret\n${"x".repeat(LOG_TAIL_MAX_BYTES + 1024)}\nrecent failure\n`,
        "utf8",
      );

      const tail = await tailFile(logPath, 2);

      expect(tail).toContain("recent failure");
      expect(tail).not.toContain("old-secret");
      expect(tail.length).toBeLessThan(LOG_TAIL_MAX_BYTES);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt("clamps oversized shell command timers before scheduling", async () => {
    const result = await runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setTimeout(() => process.exit(0), 25);",
      )}`,
      env: process.env,
      label: "oversized-command-timeout",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toMatchObject({
      noOutputTimedOut: false,
      status: 0,
      timedOut: false,
    });
  });

  posixIt("clamps oversized shell command no-output timers before scheduling", async () => {
    const result = await runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setTimeout(() => process.exit(0), 25);",
      )}`,
      env: process.env,
      label: "oversized-no-output-timeout",
      noOutputTimeoutMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      noOutputTimedOut: false,
      status: 0,
      timedOut: false,
    });
  });

  posixIt("clamps oversized shell capture timers before scheduling", async () => {
    const result = await runShellCaptureCommand({
      command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setTimeout(() => process.exit(0), 25);",
      )}`,
      env: process.env,
      label: "oversized-capture-timeout",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toMatchObject({
      status: 0,
      timedOut: false,
    });
  });

  posixIt("kills timed-out shell command groups when the leader exits first", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-docker-all-timeout-"));
    const scriptPath = path.join(root, "leader-exits.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let grandchildPid = 0;

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    try {
      const runPromise = runShellCommand({
        command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(
          scriptPath,
        )} ${JSON.stringify(grandchildPidPath)}`,
        env: process.env,
        label: "timeout-leader-exits",
        timeoutKillGraceMs: 25,
        timeoutMs: 250,
      });

      await waitFor(() => {
        grandchildPid = readCompletePidFile(grandchildPidPath) ?? 0;
        return grandchildPid > 0;
      });
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await expect(runPromise).resolves.toMatchObject({ timedOut: true });
      await waitFor(() => !isProcessAlive(grandchildPid));
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt("clamps oversized shell command kill grace before scheduling", async () => {
    const root = createTempDir("openclaw-docker-all-oversized-grace-");
    const scriptPath = path.join(root, "leader-exits.mjs");
    const donePath = path.join(root, "done");
    const readyPath = path.join(root, "ready");
    const childScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const result = await runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      env: process.env,
      label: "oversized-timeout-grace",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 500,
    });

    expect(result).toMatchObject({ timedOut: true });
    expect(readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("lets timed-out shell command descendants exit during kill grace", async () => {
    const root = createTempDir("openclaw-docker-all-grace-");
    const scriptPath = path.join(root, "leader-exits.mjs");
    const donePath = path.join(root, "done");
    const readyPath = path.join(root, "ready");
    const childScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      env: process.env,
      label: "timeout-grace",
      timeoutKillGraceMs: 500,
      timeoutMs: 500,
    });

    await waitFor(() => existsSync(readyPath));
    const result = await runPromise;
    expect(result).toMatchObject({ timedOut: true });
    expect(readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("lets timed-out shell capture descendants exit during kill grace", async () => {
    const root = createTempDir("openclaw-docker-all-capture-grace-");
    const scriptPath = path.join(root, "leader-exits.mjs");
    const donePath = path.join(root, "done");
    const readyPath = path.join(root, "ready");
    const childScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runShellCaptureCommand({
      command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      env: process.env,
      label: "capture-timeout-grace",
      timeoutKillGraceMs: 500,
      timeoutMs: 500,
    });

    await waitFor(() => existsSync(readyPath));
    const result = await runPromise;
    expect(result).toMatchObject({ timedOut: true });
    expect(readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("cleans active shell command groups before parent signal exit", async () => {
    const root = createTempDir("openclaw-docker-all-parent-signal-");
    const leaderPath = path.join(root, "leader-exits.mjs");
    const runnerPath = path.join(root, "runner.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const readyPath = path.join(root, "ready");
    const secondGrandchildPidPath = path.join(root, "second-grandchild.pid");
    const secondReadyPath = path.join(root, "second-ready");
    let grandchildPid = 0;
    let secondGrandchildPid = 0;
    let runner: ReturnType<typeof spawn> | undefined;
    const childScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "process.on('SIGHUP', () => {});",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      leaderPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
  stdio: "ignore",
});
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    // Preserve the production 10s grace while accelerating only this spawned proof's clock.
    writeFileSync(
      runnerPath,
      `
const realNow = Date.now.bind(Date);
const startedAt = realNow();
Date.now = () => startedAt + (realNow() - startedAt) * 100;

const { runShellCommand } = await import(${JSON.stringify(
        new URL("../../scripts/test-docker-all.mts", import.meta.url).href,
      )});

await runShellCommand({
  command: ${JSON.stringify(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(leaderPath)}`)},
  env: process.env,
  label: "parent-signal-cleanup",
  timeoutKillGraceMs: 100,
  timeoutMs: 30_000,
});

await runShellCommand({
  command: ${JSON.stringify(
    [
      "exec",
      JSON.stringify(process.execPath),
      "-e",
      JSON.stringify(
        [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
          `fs.writeFileSync(${JSON.stringify(secondGrandchildPidPath)}, String(child.pid));`,
          `fs.writeFileSync(${JSON.stringify(secondReadyPath)}, 'ready');`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ),
    ].join(" "),
  )},
  env: process.env,
  label: "parent-signal-second-command",
  timeoutKillGraceMs: 100,
  timeoutMs: 30_000,
});
`,
      "utf8",
    );

    try {
      runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      await waitFor(() => {
        grandchildPid = readCompletePidFile(grandchildPidPath) ?? 0;
        return existsSync(readyPath) && grandchildPid > 0;
      });
      expect(isProcessAlive(grandchildPid)).toBe(true);

      runner.kill("SIGTERM");

      await expect(waitForChildClose(runner, 15_000)).resolves.toEqual({
        code: 143,
        signal: null,
      });
      await waitFor(() => !isProcessAlive(grandchildPid));
      expect(existsSync(secondReadyPath)).toBe(false);
      if (existsSync(secondGrandchildPidPath)) {
        secondGrandchildPid = Number.parseInt(readFileSync(secondGrandchildPidPath, "utf8"), 10);
      }
      expect(secondGrandchildPid).toBe(0);
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      if (secondGrandchildPid && isProcessAlive(secondGrandchildPid)) {
        process.kill(secondGrandchildPid, "SIGKILL");
      }
      if (runner?.pid && isProcessAlive(runner.pid)) {
        runner.kill("SIGKILL");
      }
    }
  });

  it("describes effective scheduler limits for operator errors", () => {
    expect(describeDockerSchedulerLimits(2, limits)).toBe(
      "parallelism=2 weightLimit=2 resources=docker=2 npm=2",
    );
  });
});
