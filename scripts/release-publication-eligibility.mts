#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.ts";
import {
  collectClawHubPublishablePluginPackages,
  collectPluginClawHubReleasePlan,
  resolveClawHubPackagePublicationState,
  type ClawHubPackagePublicationState,
} from "./lib/plugin-clawhub-release.ts";
import {
  collectPluginReleaseDependencyFreshnessErrors,
  collectPluginReleasePlan,
  collectPluginReleaseVersionFloorErrors,
  collectPublishablePluginPackages,
  type NpmLatestVersionResolver,
  type NpmPublishedVersionResolver,
  type PublishablePluginPackage,
} from "./lib/plugin-npm-release.ts";
import { parseReleasePlanLockJson } from "./release-plan-contract.mjs";
import {
  verifyReleasePlanLock,
  type ReleasePlanSource,
  type VerifiedReleasePlanLock,
} from "./release-plan-producer.mts";
import {
  canonicalReleasePublicationEligibilityReceiptJson,
  createReleasePublicationEligibilityReceipt,
  RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
  RELEASE_PUBLICATION_ELIGIBILITY_EVIDENCE_SCOPE,
  RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS,
  RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH,
  RELEASE_PUBLICATION_NPM_REGISTRY,
  verifyReleasePublicationEligibilityReceipt,
  type ReleasePublicationEligibilityProvenance,
  type ReleasePublicationEligibilityReceipt,
} from "./release-publication-eligibility-contract.mjs";

const execFileAsync = promisify(execFile);
const OBSERVATION_CONCURRENCY = 8;
const OBSERVATION_OPERATION_TIMEOUT_MS = 90_000;
const NPM_OBSERVATION_ATTEMPTS = 3;
const NPM_OBSERVATION_TIMEOUT_MS = 60_000;
const CLAWHUB_OBSERVATION_TIMEOUT_MS = 30_000;
const SNAPSHOT_PATH_PATTERN =
  /^(?:package\.json|extensions\/[^/]+\/(?:package\.json|README\.md))$/u;
const compareAscii = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

type PackageIdentity = { name: string; version: string };
type RequiredLatestDependency = { name: string; requiredVersion: string };
type AsyncLatestResolver = (packageName: string, signal: AbortSignal) => Promise<string>;
type AsyncPublishedResolver = (
  packageName: string,
  version: string,
  signal: AbortSignal,
) => Promise<boolean>;
type AsyncClawHubStateResolver = (
  plugin: Pick<PublishablePluginPackage, "packageName" | "version">,
  signal: AbortSignal,
) => Promise<ClawHubPackagePublicationState>;
type Observation =
  | { kind: "latest"; name: string; requiredVersion: string; observedVersion: string }
  | { kind: "npm"; name: string; version: string; published: boolean }
  | ({
      kind: "clawhub";
      name: string;
      version: string;
    } & ClawHubPackagePublicationState);
type ObservationTask = {
  label: string;
  run: (signal: AbortSignal) => Promise<Observation>;
};

function packageIdentity(plugin: Pick<PublishablePluginPackage, "packageName" | "version">) {
  return { name: plugin.packageName, version: plugin.version };
}

function sortPackages<T extends PackageIdentity>(packages: readonly T[]): T[] {
  return packages.toSorted((left, right) =>
    compareAscii(`${left.name}\0${left.version}`, `${right.name}\0${right.version}`),
  );
}

function samePackages(left: readonly PackageIdentity[], right: readonly PackageIdentity[]) {
  return JSON.stringify(sortPackages(left)) === JSON.stringify(sortPackages(right));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function npmErrorDetail(error: unknown): string {
  const stderr =
    error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
  return `${errorMessage(error)}\n${stderr}`;
}

function isTransientNpmObservationError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return (
    ["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ETIMEDOUT"].includes(code) ||
    /\b(?:429|5[0-9]{2})\b|network|socket hang up|timed out/iu.test(npmErrorDetail(error))
  );
}

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} aborted before completion`);
}

async function waitWithSignal(
  milliseconds: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  await Promise.race([
    sleep(milliseconds),
    new Promise<never>((_resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(abortError(signal, "npm observation retry"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => rejectPromise(abortError(signal, "npm observation retry")),
        { once: true },
      );
    }),
  ]);
}

export async function retryNpmObservation<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolvePromise) => {
      setTimeout(resolvePromise, ms);
    }),
  signal: AbortSignal = new AbortController().signal,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (
        signal.aborted ||
        attempt >= NPM_OBSERVATION_ATTEMPTS ||
        !isTransientNpmObservationError(error)
      ) {
        throw error;
      }
      await waitWithSignal(attempt * 1_000, signal, sleep);
    }
  }
}

export function publicNpmObservationCommand(
  args: string[],
  userconfig: string,
  globalconfig: string,
  cwd: string,
) {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.toLowerCase().startsWith("npm_config_") &&
        name !== "NPM_TOKEN" &&
        name !== "NODE_AUTH_TOKEN",
    ),
  );
  return {
    args: [
      "view",
      ...args,
      "--json",
      "--registry",
      RELEASE_PUBLICATION_NPM_REGISTRY,
      "--userconfig",
      userconfig,
      "--globalconfig",
      globalconfig,
    ],
    cwd,
    env: Object.assign(cleanEnvironment, {
      HOME: cwd,
      USERPROFILE: cwd,
    }),
  };
}

async function npmView(
  args: string[],
  environment: { userconfig: string; globalconfig: string; cwd: string },
  signal: AbortSignal,
): Promise<string> {
  return await retryNpmObservation(
    async () => {
      const command = publicNpmObservationCommand(
        args,
        environment.userconfig,
        environment.globalconfig,
        environment.cwd,
      );
      const { stdout } = await execFileAsync("npm", command.args, {
        cwd: command.cwd,
        encoding: "utf8",
        env: command.env,
        killSignal: "SIGKILL",
        signal,
        timeout: NPM_OBSERVATION_TIMEOUT_MS,
      });
      return String(stdout).trim();
    },
    undefined,
    signal,
  );
}

function parseNpmVersion(raw: string, label: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`npm returned invalid JSON for ${label}`, { cause: error });
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`npm returned an invalid version for ${label}`);
  }
  return value.trim();
}

async function observeNpmLatest(
  packageName: string,
  environment: { userconfig: string; globalconfig: string; cwd: string },
  signal: AbortSignal,
): Promise<string> {
  return parseNpmVersion(
    await npmView([packageName, "dist-tags.latest"], environment, signal),
    `${packageName} dist-tags.latest`,
  );
}

async function observeNpmPublished(
  packageName: string,
  version: string,
  environment: { userconfig: string; globalconfig: string; cwd: string },
  signal: AbortSignal,
): Promise<boolean> {
  try {
    parseNpmVersion(
      await npmView([`${packageName}@${version}`, "version"], environment, signal),
      `${packageName}@${version}`,
    );
    return true;
  } catch (error) {
    if (/\bE404\b|404 Not Found/iu.test(npmErrorDetail(error))) {
      return false;
    }
    throw error;
  }
}

function collectRequiredLatestDependencies(plugins: readonly PublishablePluginPackage[]): {
  blockers: string[];
  dependencies: RequiredLatestDependency[];
} {
  const requiredVersions = new Map<string, string>();
  const blockers: string[] = [];
  for (const plugin of plugins.toSorted((left, right) =>
    compareAscii(left.packageName, right.packageName),
  )) {
    for (const dependency of plugin.requiredLatestDependencies ?? []) {
      const prior = requiredVersions.get(dependency.packageName);
      if (prior !== undefined && prior !== dependency.version) {
        blockers.push(
          `required-latest dependency ${dependency.packageName} has conflicting candidate versions ${prior} and ${dependency.version}`,
        );
        continue;
      }
      requiredVersions.set(dependency.packageName, dependency.version);
    }
  }
  return {
    blockers: blockers.toSorted(compareAscii),
    dependencies: [...requiredVersions.entries()]
      .map(([name, requiredVersion]) => ({ name, requiredVersion }))
      .toSorted((left, right) => compareAscii(left.name, right.name)),
  };
}

function interleaveTasks(groups: readonly ObservationTask[][]): ObservationTask[] {
  const tasks: ObservationTask[] = [];
  const length = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < length; index += 1) {
    for (const group of groups) {
      const task = group[index];
      if (task) {
        tasks.push(task);
      }
    }
  }
  return tasks;
}

async function runAbortableObservation(
  task: ObservationTask,
  overallSignal: AbortSignal,
  operationTimeoutMs: number,
): Promise<Observation> {
  const operationSignal = AbortSignal.timeout(operationTimeoutMs);
  const signal = AbortSignal.any([overallSignal, operationSignal]);
  try {
    return await Promise.race([
      task.run(signal),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        signal.addEventListener("abort", () => rejectPromise(abortError(signal, task.label)), {
          once: true,
        });
      }),
    ]);
  } catch (error) {
    if (operationSignal.aborted && !overallSignal.aborted) {
      throw new Error(`${task.label} exceeded ${operationTimeoutMs}ms operation cap`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function collectReleasePublicationObservations(params: {
  npmPackages: readonly PackageIdentity[];
  clawHubPlugins: readonly PublishablePluginPackage[];
  requiredLatestDependencies: readonly RequiredLatestDependency[];
  resolveLatestVersion: AsyncLatestResolver;
  resolveNpmPublishedVersion: AsyncPublishedResolver;
  resolveClawHubState: AsyncClawHubStateResolver;
  signal?: AbortSignal;
  operationTimeoutMs?: number;
}): Promise<{
  latestDependencies: Array<{
    name: string;
    requiredVersion: string;
    observedVersion: string;
  }>;
  npm: Array<PackageIdentity & { published: boolean }>;
  clawHub: Array<PackageIdentity & ClawHubPackagePublicationState>;
}> {
  const latestTasks = params.requiredLatestDependencies.map(({ name, requiredVersion }) => ({
    label: `npm latest ${name}`,
    run: async (signal: AbortSignal) => ({
      kind: "latest" as const,
      name,
      requiredVersion,
      observedVersion: await params.resolveLatestVersion(name, signal),
    }),
  }));
  const npmTasks = sortPackages(params.npmPackages).map(({ name, version }) => ({
    label: `npm publication ${name}@${version}`,
    run: async (signal: AbortSignal) => ({
      kind: "npm" as const,
      name,
      version,
      published: await params.resolveNpmPublishedVersion(name, version, signal),
    }),
  }));
  const clawHubByIdentity = new Map(
    params.clawHubPlugins.map((plugin) => [`${plugin.packageName}\0${plugin.version}`, plugin]),
  );
  const clawHubTasks = sortPackages(params.clawHubPlugins.map(packageIdentity)).map(
    ({ name, version }) => {
      const plugin = clawHubByIdentity.get(`${name}\0${version}`);
      if (!plugin) {
        throw new Error(`missing ClawHub plugin metadata for ${name}@${version}`);
      }
      return {
        label: `ClawHub publication ${name}@${version}`,
        run: async (signal: AbortSignal) =>
          Object.assign(
            {
              kind: "clawhub" as const,
              name,
              version,
            },
            await params.resolveClawHubState(plugin, signal),
          ),
      };
    },
  );
  const tasks = interleaveTasks([latestTasks, npmTasks, clawHubTasks]);
  const overallSignal =
    params.signal ?? AbortSignal.timeout(RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS);
  const errors: Array<{ index: number; message: string }> = [];
  const result = await runTasksWithConcurrency<Observation>({
    tasks: tasks.map(
      (task) => async () =>
        await runAbortableObservation(
          task,
          overallSignal,
          params.operationTimeoutMs ?? OBSERVATION_OPERATION_TIMEOUT_MS,
        ),
    ),
    limit: OBSERVATION_CONCURRENCY,
    errorMode: "continue",
    onTaskError: (error, index) => {
      errors.push({
        index,
        message: `${tasks[index]?.label ?? `observation ${index}`}: ${errorMessage(error)}`,
      });
    },
  });
  if (errors.length > 0) {
    const ordered = errors.toSorted((left, right) => left.index - right.index);
    throw new Error(
      `release publication eligibility observation failures (${ordered.length}):\n${ordered
        .map((entry) => `- ${entry.message}`)
        .join("\n")}`,
    );
  }
  const observations = result.results.filter((entry): entry is Observation => entry !== undefined);
  return {
    latestDependencies: observations
      .filter((entry) => entry.kind === "latest")
      .map(({ name, requiredVersion, observedVersion }) => ({
        name,
        requiredVersion,
        observedVersion,
      })),
    npm: observations
      .filter((entry) => entry.kind === "npm")
      .map(({ name, version, published }) => ({ name, version, published })),
    clawHub: observations
      .filter((entry) => entry.kind === "clawhub")
      .map(({ name, version, packageExists, hasTrustedPublisher, alreadyPublished }) => ({
        name,
        version,
        packageExists,
        hasTrustedPublisher,
        alreadyPublished,
      })),
  };
}

function writeReceipt(path: string, receipt: ReleasePublicationEligibilityReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, canonicalReleasePublicationEligibilityReceiptJson(receipt), {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function readRootVersion(rootDir: string): string {
  const manifest = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("candidate package.json version is required");
  }
  return manifest.version;
}

function createCandidateMetadataSnapshot(
  rootDir: string,
  candidateSha: string,
): {
  cleanup: () => void;
  rootDir: string;
} {
  let resolvedSha: string;
  try {
    resolvedSha = execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${candidateSha}^{commit}`],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    throw new Error(`ReleasePlan candidate does not resolve in the repository: ${candidateSha}`);
  }
  if (resolvedSha !== candidateSha) {
    throw new Error(`ReleasePlan candidate must resolve exactly to ${candidateSha}`);
  }
  const tree = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", candidateSha, "--", "package.json", "extensions"],
    {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const paths: string[] = [];
  for (const entry of tree.split("\0")) {
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf("\t");
    const metadata = entry.slice(0, separator);
    const path = entry.slice(separator + 1);
    if (!SNAPSHOT_PATH_PATTERN.test(path)) {
      continue;
    }
    if (!metadata.startsWith("100")) {
      throw new Error(`candidate publication metadata must be a regular file: ${path}`);
    }
    paths.push(path);
  }
  if (!paths.includes("package.json")) {
    throw new Error(`candidate package.json is missing from ${candidateSha}`);
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-release-candidate-"));
  const snapshotRoot = join(tempRoot, "snapshot");
  const archivePath = join(tempRoot, "candidate.tar");
  mkdirSync(snapshotRoot);
  try {
    execFileSync(
      "git",
      ["archive", "--format=tar", `--output=${archivePath}`, candidateSha, "--", ...paths],
      {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    execFileSync("tar", ["-xf", archivePath, "-C", snapshotRoot], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    rmSync(tempRoot, { force: true, recursive: true });
    throw new Error(`failed to materialize candidate metadata snapshot ${candidateSha}`, {
      cause: error,
    });
  }
  return {
    cleanup: () => rmSync(tempRoot, { force: true, recursive: true }),
    rootDir: snapshotRoot,
  };
}

function readNow(now: () => number, label: string): number {
  const value = now();
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer timestamp`);
  }
  return value;
}

function formatBlockers(blockers: readonly string[]): Error {
  const sorted = [...new Set(blockers)].toSorted(compareAscii);
  return new Error(
    `release publication eligibility blockers (${sorted.length}):\n${sorted
      .map((blocker) => `- ${blocker}`)
      .join("\n")}`,
  );
}

function collectPlannerBlockers(params: {
  npmPlugins: readonly PublishablePluginPackage[];
  clawHubPlugins: readonly PublishablePluginPackage[];
  observations: Awaited<ReturnType<typeof collectReleasePublicationObservations>>;
}): string[] {
  const latest = new Map(
    params.observations.latestDependencies.map((entry) => [entry.name, entry.observedVersion]),
  );
  const resolveLatestVersion: NpmLatestVersionResolver = (packageName) => {
    const version = latest.get(packageName);
    if (!version) {
      throw new Error(`missing npm latest observation for ${packageName}`);
    }
    return version;
  };
  const blockers = [
    ...collectPluginReleaseVersionFloorErrors(params.npmPlugins).map(
      (error) => `npm version: ${error}`,
    ),
    ...collectPluginReleaseVersionFloorErrors(params.clawHubPlugins).map(
      (error) => `ClawHub version: ${error}`,
    ),
    ...collectPluginReleaseDependencyFreshnessErrors(params.npmPlugins, resolveLatestVersion).map(
      (error) => `npm dependency: ${error}`,
    ),
    ...collectPluginReleaseDependencyFreshnessErrors(
      params.clawHubPlugins,
      resolveLatestVersion,
    ).map((error) => `ClawHub dependency: ${error}`),
  ];
  for (const observation of params.observations.clawHub) {
    if (!observation.packageExists) {
      blockers.push(
        `ClawHub package is not bootstrapped: ${observation.name}@${observation.version}`,
      );
    } else if (!observation.hasTrustedPublisher) {
      blockers.push(
        `ClawHub GitHub Actions trusted publisher is missing: ${observation.name}@${observation.version}`,
      );
    }
  }
  return blockers;
}

export async function collectReleasePublicationEligibility(params: {
  releasePlanLock: VerifiedReleasePlanLock;
  provenance: ReleasePublicationEligibilityProvenance;
  receiptPath: string;
  rootDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  resolveLatestVersion?: AsyncLatestResolver;
  resolveNpmPublishedVersion?: AsyncPublishedResolver;
  resolveClawHubState?: AsyncClawHubStateResolver;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ReleasePublicationEligibilityReceipt> {
  rmSync(params.receiptPath, { force: true });
  const lock = params.releasePlanLock;
  if (lock.plan.purpose !== "beta-publish" && lock.plan.purpose !== "stable-publish") {
    throw new Error("publication eligibility requires a publish ReleasePlan");
  }
  const sourceRoot = resolve(params.rootDir ?? ".");
  const now = params.now ?? Date.now;
  const startedAt = readNow(now, "publication eligibility start time");
  const overallSignal = AbortSignal.timeout(RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS);
  const candidateSnapshot = createCandidateMetadataSnapshot(sourceRoot, lock.plan.candidate_sha);
  let npmRoot: string | undefined;
  try {
    npmRoot = mkdtempSync(join(tmpdir(), "openclaw-release-eligibility-"));
    const npmEnvironment = {
      userconfig: join(npmRoot, "user.npmrc"),
      globalconfig: join(npmRoot, "global.npmrc"),
      cwd: join(npmRoot, "cwd"),
    };
    mkdirSync(npmEnvironment.cwd);
    writeFileSync(npmEnvironment.userconfig, "", { mode: 0o600 });
    writeFileSync(npmEnvironment.globalconfig, "", { mode: 0o600 });
    const snapshotRoot = candidateSnapshot.rootDir;
    const inventoryBlockers: string[] = [];
    if (readRootVersion(snapshotRoot) !== lock.plan.version) {
      inventoryBlockers.push("candidate snapshot version does not match the ReleasePlan");
    }
    const npmPackages = lock.plan.inventory.packages
      .filter((entry) => entry.targets.includes("npm"))
      .map(({ name, version }) => ({ name, version }));
    const clawHubPackages = lock.plan.inventory.packages
      .filter((entry) => entry.targets.includes("clawhub"))
      .map(({ name, version }) => ({ name, version }));
    const npmPlugins = collectPublishablePluginPackages(snapshotRoot);
    const clawHubPlugins = collectClawHubPublishablePluginPackages(snapshotRoot);
    if (!samePackages(clawHubPlugins.map(packageIdentity), clawHubPackages)) {
      inventoryBlockers.push("ClawHub candidate inventory does not exactly match the ReleasePlan");
    }
    const npmInventory = new Set(npmPackages.map(({ name, version }) => `${name}\0${version}`));
    for (const plugin of npmPlugins) {
      if (!npmInventory.has(`${plugin.packageName}\0${plugin.version}`)) {
        inventoryBlockers.push(
          `npm candidate plugin is absent from the ReleasePlan: ${plugin.packageName}@${plugin.version}`,
        );
      }
    }
    const requiredLatest = collectRequiredLatestDependencies([...npmPlugins, ...clawHubPlugins]);
    inventoryBlockers.push(...requiredLatest.blockers);
    if (inventoryBlockers.length > 0) {
      throw formatBlockers(inventoryBlockers);
    }

    const observations = await collectReleasePublicationObservations({
      npmPackages,
      clawHubPlugins,
      requiredLatestDependencies: requiredLatest.dependencies,
      signal: overallSignal,
      resolveLatestVersion:
        params.resolveLatestVersion ??
        (async (packageName, signal) =>
          await observeNpmLatest(packageName, npmEnvironment, signal)),
      resolveNpmPublishedVersion:
        params.resolveNpmPublishedVersion ??
        (async (packageName, version, signal) =>
          await observeNpmPublished(packageName, version, npmEnvironment, signal)),
      resolveClawHubState:
        params.resolveClawHubState ??
        (async (plugin, signal) =>
          await resolveClawHubPackagePublicationState(plugin, {
            registryBaseUrl: RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
            fetchImpl: params.fetchImpl,
            requestTimeoutMs: CLAWHUB_OBSERVATION_TIMEOUT_MS,
            signal,
            sleep: params.sleep,
          })),
    });
    if (
      !samePackages(
        observations.latestDependencies.map((entry) => ({
          name: entry.name,
          version: entry.requiredVersion,
        })),
        requiredLatest.dependencies.map((entry) => ({
          name: entry.name,
          version: entry.requiredVersion,
        })),
      )
    ) {
      throw new Error("required-latest dependency observation set drifted from candidate metadata");
    }
    const blockers = collectPlannerBlockers({ npmPlugins, clawHubPlugins, observations });
    if (blockers.length > 0) {
      throw formatBlockers(blockers);
    }

    const latest = new Map(
      observations.latestDependencies.map((entry) => [entry.name, entry.observedVersion]),
    );
    const npmPublished = new Map(
      observations.npm.map((entry) => [`${entry.name}\0${entry.version}`, entry.published]),
    );
    const clawHubState = new Map(
      observations.clawHub.map((entry) => [
        `${entry.name}\0${entry.version}`,
        {
          packageExists: entry.packageExists,
          hasTrustedPublisher: entry.hasTrustedPublisher,
          alreadyPublished: entry.alreadyPublished,
        },
      ]),
    );
    const resolveLatestVersion: NpmLatestVersionResolver = (packageName) => {
      const version = latest.get(packageName);
      if (!version) {
        throw new Error(`missing npm latest observation for ${packageName}`);
      }
      return version;
    };
    const resolvePublishedVersion: NpmPublishedVersionResolver = (packageName, version) => {
      const published = npmPublished.get(`${packageName}\0${version}`);
      if (published === undefined) {
        throw new Error(`missing npm publication observation for ${packageName}@${version}`);
      }
      return published;
    };
    const plannerResults = await Promise.allSettled([
      Promise.resolve().then(() =>
        collectPluginReleasePlan({
          rootDir: snapshotRoot,
          selectionMode: "all-publishable",
          resolveLatestVersion,
          resolvePublishedVersion,
        }),
      ),
      collectPluginClawHubReleasePlan({
        rootDir: snapshotRoot,
        selectionMode: "all-publishable",
        registryBaseUrl: RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
        resolveLatestVersion,
        resolvePackageState: async (plugin) => {
          const state = clawHubState.get(`${plugin.packageName}\0${plugin.version}`);
          if (!state) {
            throw new Error(
              `missing ClawHub publication observation for ${plugin.packageName}@${plugin.version}`,
            );
          }
          return state;
        },
      }),
    ]);
    const plannerFailures = plannerResults.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "npm" : "ClawHub"} planner: ${errorMessage(result.reason)}`]
        : [],
    );
    if (plannerFailures.length > 0) {
      throw formatBlockers(plannerFailures);
    }
    const npmPlannerResult = plannerResults[0];
    const clawHubPlannerResult = plannerResults[1];
    if (npmPlannerResult?.status !== "fulfilled" || clawHubPlannerResult?.status !== "fulfilled") {
      throw new Error("publication planner results were incomplete");
    }
    const npmPluginPlan = npmPlannerResult.value;
    const clawHubPluginPlan = clawHubPlannerResult.value;
    const plannerDrift: string[] = [];
    if (!samePackages(npmPluginPlan.all.map(packageIdentity), npmPlugins.map(packageIdentity))) {
      plannerDrift.push("npm planner inventory drifted from candidate metadata");
    }
    if (!samePackages(clawHubPluginPlan.all.map(packageIdentity), clawHubPackages)) {
      plannerDrift.push("ClawHub planner inventory drifted from the ReleasePlan");
    }
    if (
      clawHubPluginPlan.bootstrapCandidates.length > 0 ||
      clawHubPluginPlan.missingTrustedPublisher.length > 0
    ) {
      plannerDrift.push("ClawHub planner returned an ineligible trust or bootstrap state");
    }
    if (plannerDrift.length > 0) {
      throw formatBlockers(plannerDrift);
    }

    const completedAt = readNow(now, "publication eligibility completion time");
    if (completedAt > startedAt + RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS) {
      throw new Error("release publication eligibility exceeded five minutes; recollect");
    }
    const receipt = createReleasePublicationEligibilityReceipt({
      schema: "openclaw.release-publication-eligibility.v1",
      evidence_scope: RELEASE_PUBLICATION_ELIGIBILITY_EVIDENCE_SCOPE,
      publication_authorized: false,
      release_plan_digest: lock.digest,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      expires_at: new Date(startedAt + RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS).toISOString(),
      registries: {
        clawhub: RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
        npm: RELEASE_PUBLICATION_NPM_REGISTRY,
      },
      provenance: params.provenance,
      observations: {
        latest_dependencies: observations.latestDependencies.map(
          ({ name, requiredVersion, observedVersion }) => ({
            name,
            required_version: requiredVersion,
            observed_version: observedVersion,
          }),
        ),
        npm: sortPackages(observations.npm),
        clawhub: sortPackages(
          observations.clawHub.map(
            ({ name, version, packageExists, hasTrustedPublisher, alreadyPublished }) => ({
              name,
              version,
              package_exists: packageExists,
              trusted_publisher: hasTrustedPublisher,
              published: alreadyPublished,
            }),
          ),
        ),
      },
      plans: {
        npm: sortPackages(
          observations.npm.map(({ name, version, published }) => ({
            name,
            version,
            status: published ? "already-published" : "vacant",
          })),
        ),
        clawhub: sortPackages(
          observations.clawHub.map(({ name, version, alreadyPublished }) => ({
            name,
            version,
            status: alreadyPublished ? "already-published" : "vacant",
          })),
        ),
      },
    });
    verifyReleasePublicationEligibilityReceipt(receipt, lock, params.provenance, completedAt);
    writeReceipt(params.receiptPath, receipt);
    return receipt;
  } finally {
    candidateSnapshot.cleanup();
    if (npmRoot) {
      rmSync(npmRoot, { force: true, recursive: true });
    }
  }
}

function requiredOption(args: string[], name: string): string {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  const index = indexes[0];
  if (indexes.length !== 1 || index === undefined) {
    throw new Error(`${name} must be provided exactly once`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export async function runReleasePublicationEligibilityCli(
  args: string[],
  dependencies: {
    collect?: typeof collectReleasePublicationEligibility;
    verifyLock?: (lockJson: string, source: ReleasePlanSource) => VerifiedReleasePlanLock;
  } = {},
): Promise<ReleasePublicationEligibilityReceipt> {
  const knownFlags = new Set([
    "--release-plan-lock",
    "--receipt",
    "--repo-root",
    "--run-id",
    "--run-attempt",
    "--job",
    "--artifact-id",
    "--artifact-digest",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    if (!knownFlags.has(args[index] ?? "")) {
      throw new Error(
        `unknown release publication eligibility option: ${args[index] ?? "<missing>"}`,
      );
    }
  }
  const repoRoot = resolve(requiredOption(args, "--repo-root"));
  const lockJson = readFileSync(requiredOption(args, "--release-plan-lock"), "utf8");
  const lockHint = parseReleasePlanLockJson(lockJson);
  const source: ReleasePlanSource = {
    repoRoot,
    intent: "publish",
    candidateSha: lockHint.plan.candidate_sha,
    candidateRef: lockHint.plan.target_context_ref,
    toolingSha: lockHint.plan.tooling.sha,
    toolingFullRef: lockHint.plan.tooling.ref,
  };
  const lock = (dependencies.verifyLock ?? verifyReleasePlanLock)(lockJson, source);
  const runAttempt = Number(requiredOption(args, "--run-attempt"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
    throw new Error("--run-attempt must be a positive safe integer");
  }
  const provenance: ReleasePublicationEligibilityProvenance = {
    repository: lock.plan.tooling.repository,
    workflow_path: RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH,
    workflow_ref: lock.plan.tooling.ref,
    workflow_sha: lock.plan.tooling.sha,
    run_id: requiredOption(args, "--run-id"),
    run_attempt: runAttempt,
    job: requiredOption(args, "--job"),
    artifact_id: requiredOption(args, "--artifact-id"),
    artifact_digest: requiredOption(args, "--artifact-digest"),
  };
  return await (dependencies.collect ?? collectReleasePublicationEligibility)({
    releasePlanLock: lock,
    provenance,
    receiptPath: requiredOption(args, "--receipt"),
    rootDir: repoRoot,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runReleasePublicationEligibilityCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(errorMessage(error));
    console.error("[release-publication-eligibility] FAILED (exit 1)");
    process.exitCode = 1;
  });
}
