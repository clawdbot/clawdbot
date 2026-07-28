// Plugin Clawhub Release script supports OpenClaw repository automation.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.js";
import { validateExternalCodePluginPackageJson } from "../../packages/plugin-package-contract/src/index.ts";
import { retryClawHubRead } from "../../src/infra/clawhub-retry.js";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";
import { readBoundedResponseText } from "./bounded-response.ts";
import {
  assertPluginReleaseDependencyFreshness,
  collectExtensionPackageJsonCandidates,
  collectChangedPathsFromGitRange,
  collectChangedExtensionIdsFromPaths,
  collectPublishablePluginPackageErrors,
  collectRequiredLatestDependencies,
  assertPluginReleaseVersionFloors,
  parsePluginReleaseArgs,
  resolvePublishablePluginVersion,
  resolveGitCommitSha,
  resolveChangedPublishablePluginPackages,
  resolveSelectedPublishablePluginPackages,
  type GitRangeSelection,
  type NpmLatestVersionResolver,
  type PluginReleaseSelectionMode,
  type RequiredLatestDependency,
} from "./plugin-npm-release.ts";

export {
  assertPluginReleaseDependencyFreshness,
  assertPluginReleaseVersionFloors,
  parsePluginReleaseArgs,
};

type PluginPackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  openclaw?: {
    extensions?: string[];
    install?: {
      npmSpec?: string;
    };
    compat?: {
      pluginApi?: string;
      minGatewayVersion?: string;
    };
    build?: {
      openclawVersion?: string;
      pluginSdkVersion?: string;
    };
    release?: {
      publishToClawHub?: boolean;
      publishToNpm?: boolean;
    };
  };
};

export type PublishablePluginPackage = {
  extensionId: string;
  packageDir: string;
  packageName: string;
  version: string;
  channel: "stable" | "alpha" | "beta";
  publishTag: "latest" | "alpha" | "beta" | "extended-stable";
  requiredLatestDependencies?: RequiredLatestDependency[];
};

type PluginReleasePlanItem = PublishablePluginPackage & {
  alreadyPublished: boolean;
  artifactName: string;
};

type PluginReleasePlan = {
  all: PluginReleasePlanItem[];
  candidates: PluginReleasePlanItem[];
  bootstrapCandidates: PluginReleasePlanItem[];
  missingTrustedPublisher: PluginReleasePlanItem[];
  skippedPublished: PluginReleasePlanItem[];
};

type ClawHubTrustedPublisherDetail = {
  trustedPublisher?: unknown;
};

type ClawHubTrustedPublisherConfig = {
  repository?: unknown;
  workflowFilename?: unknown;
  environment?: unknown;
};

type PluginReleasePlanItemWithPackageState = PluginReleasePlanItem & {
  packageExists: boolean;
  hasTrustedPublisher: boolean;
};

type ClawHubPublishablePluginPackageFilters = {
  extensionIds?: readonly string[];
  packageNames?: readonly string[];
};

const CLAWHUB_DEFAULT_REGISTRY = "https://clawhub.ai";
const CLAWHUB_REQUEST_TIMEOUT_MS = 30_000;
const CLAWHUB_RESPONSE_BODY_MAX_BYTES = 64 * 1024;
const CLAWHUB_ERROR_BODY_MAX_BYTES = 8 * 1024;
const CLAWHUB_ERROR_BODY_MAX_CHARS = 400;
// All-publishable releases query dozens of packages. Bound registry pressure while
// allowing independent package state reads to leave the core publish critical path quickly.
const CLAWHUB_RELEASE_PLAN_CONCURRENCY = 8;
const OPENCLAW_PLUGIN_CLAWHUB_REPOSITORY = "openclaw/openclaw";
const OPENCLAW_PLUGIN_CLAWHUB_WORKFLOW_FILENAME = "plugin-clawhub-release.yml";
const SAFE_EXTENSION_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CLAWHUB_SHARED_RELEASE_INPUT_PATHS = [
  ".github/workflows/plugin-clawhub-release.yml",
  ".github/actions/setup-node-env",
  "package.json",
  "pnpm-lock.yaml",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/lib/bounded-response.ts",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/release-version.mjs",
  "scripts/lib/plugin-npm-release.ts",
  "scripts/lib/plugin-clawhub-release.ts",
  "scripts/openclaw-npm-release-check.ts",
  "scripts/plugin-clawhub-publish.sh",
  "scripts/plugin-clawhub-release-check.ts",
  "scripts/plugin-clawhub-release-plan.ts",
] as const;

function getRegistryBaseUrl(explicit?: string) {
  return (
    explicit?.trim() ||
    process.env.CLAWHUB_REGISTRY?.trim() ||
    process.env.CLAWHUB_SITE?.trim() ||
    CLAWHUB_DEFAULT_REGISTRY
  );
}

type ClawHubRequestOptions = {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

type ClawHubRetryOptions = ClawHubRequestOptions & {
  sleep?: (ms: number) => Promise<void>;
};

async function fetchClawHubRequest(
  url: URL,
  options: ClawHubRequestOptions = {},
): Promise<{
  clearTimeout: () => void;
  response: Response;
  signal: AbortSignal;
  timeoutPromise: Promise<never>;
}> {
  const timeoutMs = options.requestTimeoutMs ?? CLAWHUB_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutError = Object.assign(
    new Error(`ClawHub request timed out after ${timeoutMs}ms: ${url.href}`),
    { code: "ETIMEDOUT" },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return {
      clearTimeout: () => clearTimeout(timeout),
      response,
      signal: controller.signal,
      timeoutPromise,
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function cancelClawHubResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchClawHubRead(
  url: URL,
  options: ClawHubRetryOptions = {},
): Promise<Awaited<ReturnType<typeof fetchClawHubRequest>>> {
  return await retryClawHubRead(
    () =>
      fetchClawHubRequest(url, {
        fetchImpl: options.fetchImpl,
        requestTimeoutMs: options.requestTimeoutMs,
      }),
    {
      disposeRetry: async (request) => {
        await cancelClawHubResponseBody(request.response);
        request.clearTimeout();
      },
      retryRateLimit: true,
      sleep: options.sleep,
    },
  );
}

async function buildClawHubQueryError(
  message: string,
  request: Awaited<ReturnType<typeof fetchClawHubRequest>>,
): Promise<Error> {
  const { response } = request;
  let body: string;
  try {
    body = (
      await readBoundedResponseText(response, message, CLAWHUB_ERROR_BODY_MAX_BYTES, {
        signal: request.signal,
        timeoutPromise: request.timeoutPromise,
      })
    )
      .replace(/\s+/gu, " ")
      .trim();
  } catch {
    body = "";
  }
  if (body.length > CLAWHUB_ERROR_BODY_MAX_CHARS) {
    body = `${truncateUtf16Safe(body, CLAWHUB_ERROR_BODY_MAX_CHARS)}...`;
  }
  const diagnosticHeaders = ["retry-after", "x-request-id", "x-vercel-id", "cf-ray"]
    .map((name) => {
      const value = response.headers.get(name)?.trim();
      return value ? `${name}=${value}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  const detail = [
    body || response.statusText || `HTTP ${response.status}`,
    diagnosticHeaders.length > 0 ? `[${diagnosticHeaders.join("; ")}]` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return new Error(`${message}: ${response.status} ${detail}`);
}

function formatClawHubPackageArtifactName(
  plugin: Pick<PublishablePluginPackage, "packageName" | "version">,
) {
  const safeName = plugin.packageName
    .replace(/^@/u, "")
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `clawhub-package-${safeName}-${plugin.version}`;
}

export function collectClawHubPublishablePluginPackages(
  rootDir = resolve("."),
  filters: ClawHubPublishablePluginPackageFilters = {},
): PublishablePluginPackage[] {
  const publishable: PublishablePluginPackage[] = [];
  const validationErrors: string[] = [];
  const selectedExtensionIds = new Set(filters.extensionIds ?? []);
  const selectedPackageNames = new Set(filters.packageNames ?? []);
  const hasSelectedExtensionIds = Array.isArray(filters.extensionIds);
  const hasSelectedPackageNames = Array.isArray(filters.packageNames);

  for (const candidate of collectExtensionPackageJsonCandidates(rootDir)) {
    const { extensionId, packageDir, packageJson } = candidate;
    if (hasSelectedExtensionIds && !selectedExtensionIds.has(extensionId)) {
      continue;
    }
    const packageName = packageJson.name?.trim() ?? "";
    if (hasSelectedPackageNames && !selectedPackageNames.has(packageName)) {
      continue;
    }
    if (packageJson.openclaw?.release?.publishToClawHub !== true) {
      continue;
    }
    if (!SAFE_EXTENSION_ID_RE.test(extensionId)) {
      validationErrors.push(
        `${extensionId}: extension directory name must match ^[a-z0-9][a-z0-9._-]*$ for ClawHub publish.`,
      );
      continue;
    }

    const errors = collectPublishablePluginPackageErrors(candidate);
    if (errors.length > 0) {
      validationErrors.push(...errors.map((error) => `${extensionId}: ${error}`));
      continue;
    }
    const contractValidation = validateExternalCodePluginPackageJson(packageJson);
    if (contractValidation.issues.length > 0) {
      validationErrors.push(
        ...contractValidation.issues.map((issue) => `${extensionId}: ${issue.message}`),
      );
      continue;
    }

    const resolvedVersion = resolvePublishablePluginVersion({
      extensionId,
      packageJson,
      validationErrors,
    });
    if (!resolvedVersion) {
      continue;
    }
    const { version, parsedVersion } = resolvedVersion;
    const requiredLatestDependencies = collectRequiredLatestDependencies(packageJson).dependencies;

    publishable.push({
      extensionId,
      packageDir,
      packageName,
      version,
      channel: parsedVersion.channel,
      publishTag:
        parsedVersion.channel === "alpha"
          ? "alpha"
          : parsedVersion.channel === "beta"
            ? "beta"
            : "latest",
      ...(requiredLatestDependencies.length > 0 ? { requiredLatestDependencies } : {}),
    });
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Publishable ClawHub plugin metadata validation failed:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  return publishable.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

export function collectPluginClawHubReleasePathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectPluginClawHubReleasePathsFromGitRangeForPathspecs(params, ["extensions"]);
}

function collectPluginClawHubRelevantPathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectPluginClawHubReleasePathsFromGitRangeForPathspecs(params, [
    "extensions",
    ...CLAWHUB_SHARED_RELEASE_INPUT_PATHS,
  ]);
}

function collectPluginClawHubReleasePathsFromGitRangeForPathspecs(
  params: {
    rootDir?: string;
    gitRange: GitRangeSelection;
  },
  pathspecs: readonly string[],
): string[] {
  return collectChangedPathsFromGitRange({
    rootDir: params.rootDir,
    gitRange: params.gitRange,
    pathspecs,
  });
}

function hasSharedClawHubReleaseInputChanges(changedPaths: readonly string[]) {
  return changedPaths.some((path) =>
    CLAWHUB_SHARED_RELEASE_INPUT_PATHS.some(
      (sharedPath) => path === sharedPath || path.startsWith(`${sharedPath}/`),
    ),
  );
}

export function resolveChangedClawHubPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  changedPaths: readonly string[];
}): PublishablePluginPackage[] {
  return resolveChangedPublishablePluginPackages({
    plugins: params.plugins,
    changedExtensionIds: collectChangedExtensionIdsFromPaths(params.changedPaths),
  });
}

export function resolveSelectedClawHubPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  rootDir?: string;
}): PublishablePluginPackage[] {
  if (params.selectionMode === "all-publishable") {
    return params.plugins;
  }
  if (params.selection && params.selection.length > 0) {
    return resolveSelectedPublishablePluginPackages({
      plugins: params.plugins,
      selection: params.selection,
    });
  }
  if (params.gitRange) {
    const changedPaths = collectPluginClawHubRelevantPathsFromGitRange({
      rootDir: params.rootDir,
      gitRange: params.gitRange,
    });
    if (hasSharedClawHubReleaseInputChanges(changedPaths)) {
      return params.plugins;
    }
    return resolveChangedClawHubPublishablePluginPackages({
      plugins: params.plugins,
      changedPaths,
    });
  }
  return params.plugins;
}

function readPackageManifestAtGitRef(params: {
  rootDir?: string;
  ref: string;
  packageDir: string;
}): PluginPackageJson | null {
  const rootDir = params.rootDir ?? resolve(".");
  const commitSha = resolveGitCommitSha(rootDir, params.ref, "ref");
  try {
    const raw = execFileSync("git", ["show", `${commitSha}:${params.packageDir}/package.json`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(raw) as PluginPackageJson;
  } catch {
    return null;
  }
}

export function collectClawHubVersionGateErrors(params: {
  plugins: PublishablePluginPackage[];
  gitRange: GitRangeSelection;
  rootDir?: string;
}): string[] {
  const changedPaths = collectPluginClawHubReleasePathsFromGitRange({
    rootDir: params.rootDir,
    gitRange: params.gitRange,
  });
  const changedPlugins = resolveChangedClawHubPublishablePluginPackages({
    plugins: params.plugins,
    changedPaths,
  });

  const errors: string[] = [];
  for (const plugin of changedPlugins) {
    const baseManifest = readPackageManifestAtGitRef({
      rootDir: params.rootDir,
      ref: params.gitRange.baseRef,
      packageDir: plugin.packageDir,
    });
    if (baseManifest?.openclaw?.release?.publishToClawHub !== true) {
      continue;
    }
    const baseVersion =
      typeof baseManifest.version === "string" && baseManifest.version.trim()
        ? baseManifest.version.trim()
        : null;
    if (baseVersion === null || baseVersion !== plugin.version) {
      continue;
    }
    errors.push(
      `${plugin.packageName}@${plugin.version}: changed publishable plugin still has the same version in package.json.`,
    );
  }

  return errors;
}

async function isPluginVersionPublishedOnClawHub(
  packageName: string,
  version: string,
  options: ClawHubRetryOptions & { registryBaseUrl?: string } = {},
): Promise<boolean> {
  const url = new URL(
    `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`,
    getRegistryBaseUrl(options.registryBaseUrl),
  );
  const request = await fetchClawHubRead(url, {
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.requestTimeoutMs,
    sleep: options.sleep,
  });
  const { response } = request;

  try {
    if (response.status === 404) {
      return false;
    }
    if (response.ok) {
      return true;
    }

    throw await buildClawHubQueryError(
      `Failed to query ClawHub for ${packageName}@${version}`,
      request,
    );
  } finally {
    await cancelClawHubResponseBody(response);
    request.clearTimeout();
  }
}

async function doesClawHubPackageExist(
  packageName: string,
  options: ClawHubRetryOptions & { registryBaseUrl?: string } = {},
): Promise<boolean> {
  const url = new URL(
    `/api/v1/packages/${encodeURIComponent(packageName)}`,
    getRegistryBaseUrl(options.registryBaseUrl),
  );
  const request = await fetchClawHubRead(url, {
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.requestTimeoutMs,
    sleep: options.sleep,
  });
  const { response } = request;

  try {
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw await buildClawHubQueryError(`Failed to query ClawHub package ${packageName}`, request);
    }

    return true;
  } finally {
    await cancelClawHubResponseBody(response);
    request.clearTimeout();
  }
}

async function hasClawHubTrustedPublisher(
  packageName: string,
  options: ClawHubRetryOptions & {
    registryBaseUrl?: string;
  } = {},
): Promise<boolean> {
  const url = new URL(
    `/api/v1/packages/${encodeURIComponent(packageName)}/trusted-publisher`,
    getRegistryBaseUrl(options.registryBaseUrl),
  );
  const request = await fetchClawHubRead(url, options);
  const { response } = request;
  try {
    if (!response.ok) {
      throw await buildClawHubQueryError(
        `Failed to query ClawHub trusted publisher for ${packageName}`,
        request,
      );
    }

    let trustedPublisherDetail: ClawHubTrustedPublisherDetail;
    const text = await readBoundedResponseText(
      response,
      `ClawHub trusted publisher ${packageName}`,
      CLAWHUB_RESPONSE_BODY_MAX_BYTES,
      {
        signal: request.signal,
        timeoutPromise: request.timeoutPromise,
      },
    );
    try {
      trustedPublisherDetail = JSON.parse(text) as ClawHubTrustedPublisherDetail;
    } catch (error) {
      throw new Error(`Failed to parse ClawHub trusted publisher ${packageName} response.`, {
        cause: error,
      });
    }

    return isOpenClawPluginTrustedPublisher(trustedPublisherDetail.trustedPublisher);
  } finally {
    request.clearTimeout();
  }
}

function isOpenClawPluginTrustedPublisher(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const trustedPublisher = value as ClawHubTrustedPublisherConfig;
  return (
    trustedPublisher.repository === OPENCLAW_PLUGIN_CLAWHUB_REPOSITORY &&
    trustedPublisher.workflowFilename === OPENCLAW_PLUGIN_CLAWHUB_WORKFLOW_FILENAME &&
    trustedPublisher.environment == null
  );
}

function stripPackageReleaseState(
  item: PluginReleasePlanItemWithPackageState,
): PluginReleasePlanItem {
  const {
    packageExists: _packageExists,
    hasTrustedPublisher: _hasTrustedPublisher,
    ...planItem
  } = item;
  return planItem;
}

export async function collectPluginClawHubReleasePlan(params?: {
  rootDir?: string;
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  registryBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  resolveLatestVersion?: NpmLatestVersionResolver;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PluginReleasePlan> {
  const rootDir = params?.rootDir;
  const selection = params?.selection ?? [];
  const changedPaths = params?.gitRange
    ? collectPluginClawHubRelevantPathsFromGitRange({
        rootDir,
        gitRange: params.gitRange,
      })
    : [];
  const sharedInputChanged = hasSharedClawHubReleaseInputChanges(changedPaths);
  const extensionIds =
    params?.selectionMode === "all-publishable" || !params?.gitRange || sharedInputChanged
      ? undefined
      : collectChangedExtensionIdsFromPaths(changedPaths);
  const allPublishable = collectClawHubPublishablePluginPackages(rootDir, {
    extensionIds,
    packageNames: selection.length > 0 ? selection : undefined,
  });
  const selectedPublishable = resolveSelectedClawHubPublishablePluginPackages({
    plugins: allPublishable,
    selection,
    selectionMode: params?.selectionMode,
    gitRange: params?.gitRange,
    rootDir,
  });

  const explicitPublishSelection = params?.selectionMode !== undefined || selection.length > 0;
  if (explicitPublishSelection) {
    assertPluginReleaseVersionFloors(selectedPublishable, "Plugin ClawHub release plan");
  }
  assertPluginReleaseDependencyFreshness(
    selectedPublishable,
    "Plugin ClawHub release plan",
    params?.resolveLatestVersion,
  );

  const planTasks = selectedPublishable.map((plugin) => async () => {
    const queryOptions = {
      registryBaseUrl: params?.registryBaseUrl,
      fetchImpl: params?.fetchImpl,
      requestTimeoutMs: params?.requestTimeoutMs,
      sleep: params?.sleep,
    };
    const packageExists = await doesClawHubPackageExist(plugin.packageName, queryOptions);
    const hasTrustedPublisher = packageExists
      ? await hasClawHubTrustedPublisher(plugin.packageName, queryOptions)
      : false;
    const alreadyPublished = packageExists
      ? await isPluginVersionPublishedOnClawHub(plugin.packageName, plugin.version, queryOptions)
      : false;

    return {
      extensionId: plugin.extensionId,
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      version: plugin.version,
      channel: plugin.channel,
      publishTag: plugin.publishTag,
      packageExists,
      hasTrustedPublisher,
      alreadyPublished,
      artifactName: formatClawHubPackageArtifactName(plugin),
    } satisfies PluginReleasePlanItemWithPackageState;
  });
  const planResult = await runTasksWithConcurrency({
    tasks: planTasks,
    limit: CLAWHUB_RELEASE_PLAN_CONCURRENCY,
    errorMode: "stop",
  });
  if (planResult.hasError) {
    throw planResult.firstError;
  }
  const planned = planResult.results;
  const all = planned.map(stripPackageReleaseState);

  return {
    all,
    candidates: planned
      .filter(
        (plugin) => plugin.packageExists && plugin.hasTrustedPublisher && !plugin.alreadyPublished,
      )
      .map(stripPackageReleaseState),
    bootstrapCandidates: planned
      .filter((plugin) => !plugin.packageExists)
      .map(stripPackageReleaseState),
    missingTrustedPublisher: planned
      .filter((plugin) => plugin.packageExists && !plugin.hasTrustedPublisher)
      .map(stripPackageReleaseState),
    skippedPublished: planned
      .filter((plugin) => plugin.alreadyPublished)
      .map(stripPackageReleaseState),
  };
}
