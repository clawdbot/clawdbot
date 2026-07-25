import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODEL_CATALOG_MIN_VERSION = "2026.7.0";
export const MODEL_CATALOG_MIN_MODELS = 200;
export const MODEL_CATALOG_R2_OBJECT_KEY = "models/v1/catalog.json";

const SCRIPT_LABEL = "publish-model-catalog";
const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireOptionValue(args, index, flag) {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePublishModelCatalogArgs(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--out") {
      options.out = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--bucket") {
      options.bucket = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.dryRun && !options.out && !options.bucket) {
    throw new Error("provide --out <file>, --bucket <bucket>, or --dry-run");
  }
  return options;
}

export function readModelCatalogManifests(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const extensionsDir = path.join(rootDir, "extensions");
  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      pluginId: entry.name,
      manifestPath: path.join(extensionsDir, entry.name, "openclaw.plugin.json"),
    }))
    .filter((entry) => fs.existsSync(entry.manifestPath))
    .map((entry) => ({
      pluginId: entry.pluginId,
      manifestPath: entry.manifestPath,
      manifest: JSON.parse(fs.readFileSync(entry.manifestPath, "utf8")),
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

async function loadClientBundleValidator() {
  const { tsImport } = await import("tsx/esm/api");
  const modulePath = path.join(
    defaultRootDir,
    "packages/model-catalog-core/src/remote-catalog-bundle.ts",
  );
  const module = await tsImport(pathToFileURL(modulePath).href, import.meta.url);
  if (typeof module.validateAndSanitizeRemoteModelCatalogBundle !== "function") {
    throw new Error("remote catalog bundle validator export is unavailable");
  }
  return module.validateAndSanitizeRemoteModelCatalogBundle;
}

export async function assembleModelCatalogBundle(options) {
  const providers = {};
  for (const entry of options.manifests) {
    const declaredProviders = entry.manifest?.modelCatalog?.providers;
    if (
      !declaredProviders ||
      typeof declaredProviders !== "object" ||
      Array.isArray(declaredProviders)
    ) {
      continue;
    }
    for (const [providerId, provider] of Object.entries(declaredProviders)) {
      if (Object.hasOwn(providers, providerId)) {
        throw new Error(`provider ${providerId} is declared by more than one plugin manifest`);
      }
      providers[providerId] = provider;
    }
  }

  if (!Object.hasOwn(providers, "anthropic") || !Object.hasOwn(providers, "openai")) {
    throw new Error("catalog must include anthropic and openai providers");
  }

  const bundle = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    minVersion: options.minVersion ?? MODEL_CATALOG_MIN_VERSION,
    sourceCommit: options.sourceCommit,
    providers,
  };
  const validateBundle = options.validateBundle ?? (await loadClientBundleValidator());
  const validated = validateBundle(bundle);
  const summary = summarizeModelCatalogBundle(validated);
  if (summary.models < MODEL_CATALOG_MIN_MODELS) {
    throw new Error(
      `catalog model count ${summary.models} is below required floor ${MODEL_CATALOG_MIN_MODELS}`,
    );
  }
  return validated;
}

export function summarizeModelCatalogBundle(bundle) {
  const providerRows = Object.values(bundle.providers);
  return {
    providers: providerRows.length,
    models: providerRows.reduce((total, provider) => total + provider.models.length, 0),
  };
}

function resolveSourceCommit(rootDir) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function requireUploadEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required with --bucket`);
  }
  return value;
}

function uploadBundleToR2({ bucket, file, env, spawnSyncImpl }) {
  const endpoint = requireUploadEnv(env, "R2_MODEL_CATALOG_ENDPOINT");
  const accountId = requireUploadEnv(env, "R2_MODEL_CATALOG_ACCOUNT_ID");
  const apiToken = requireUploadEnv(env, "R2_MODEL_CATALOG_API_TOKEN");
  const result = spawnSyncImpl(
    "wrangler",
    ["r2", "object", "put", `${bucket}/${MODEL_CATALOG_R2_OBJECT_KEY}`, "--file", file, "--remote"],
    {
      cwd: defaultRootDir,
      encoding: "utf8",
      env: {
        ...env,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: apiToken,
        CLOUDFLARE_API_BASE_URL: endpoint,
      },
    },
  );
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    const error = new Error(`wrangler upload failed with exit ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

export async function runPublishModelCatalog(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const args = parsePublishModelCatalogArgs(options.args ?? process.argv.slice(2));
  const generatedAt = (options.now ?? Date.now)();
  const sourceCommit = options.sourceCommit ?? resolveSourceCommit(rootDir);
  const bundle = await assembleModelCatalogBundle({
    manifests: readModelCatalogManifests({ rootDir }),
    generatedAt,
    sourceCommit,
  });
  const summary = summarizeModelCatalogBundle(bundle);
  const stats = `schemaVersion=1 providers=${summary.providers} models=${summary.models} generatedAt=${bundle.generatedAt} minVersion=${bundle.minVersion} sourceCommit=${bundle.sourceCommit}`;
  if (args.dryRun) {
    process.stdout.write(`[${SCRIPT_LABEL}] dry-run ${stats}\n`);
    return { bundle, summary, wrote: false, uploaded: false };
  }

  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  let uploadFile = args.out ? path.resolve(rootDir, args.out) : undefined;
  let temporaryDir;
  if (args.out) {
    fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
    fs.writeFileSync(uploadFile, serialized);
  }
  try {
    if (args.bucket) {
      if (!uploadFile) {
        temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-catalog-"));
        uploadFile = path.join(temporaryDir, "catalog.json");
        fs.writeFileSync(uploadFile, serialized);
      }
      uploadBundleToR2({
        bucket: args.bucket,
        file: uploadFile,
        env: options.env ?? process.env,
        spawnSyncImpl: options.spawnSyncImpl ?? spawnSync,
      });
    }
  } finally {
    if (temporaryDir) {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    `[${SCRIPT_LABEL}] published ${stats}${args.out ? ` out=${args.out}` : ""}${args.bucket ? ` bucket=${args.bucket}` : ""}\n`,
  );
  return { bundle, summary, wrote: Boolean(args.out), uploaded: Boolean(args.bucket) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runPublishModelCatalog();
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`[${SCRIPT_LABEL}] FAILED (exit ${exitCode})\n`);
    process.exitCode = exitCode;
  }
}
