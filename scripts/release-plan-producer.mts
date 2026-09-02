#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deserialize, serialize } from "node:v8";

export type ReleasePlanIntent =
  | "publish"
  | "diagnostic"
  | "postpublish-confidence"
  | "main-qualification";
export type MainQualificationValidationIntent = "main-daily" | "main-weekly";
type RunGh = (args: string[]) => string;
type ReleasePlanSourceBase = {
  repoRoot?: string;
  candidateSha: string;
  candidateRef: string;
  toolingSha: string;
  toolingFullRef: string;
  runGh?: RunGh;
};
export type ReleasePlanSource =
  | (ReleasePlanSourceBase & {
      intent: "main-qualification";
      validationIntent: MainQualificationValidationIntent;
    })
  | (ReleasePlanSourceBase & {
      intent: Exclude<ReleasePlanIntent, "main-qualification">;
      validationIntent?: never;
    });
type ReleasePlan = {
  schema: string;
  release_id: string;
  version: string;
  tag: string | null;
  candidate_sha: string;
  target_context_ref: string;
  purpose: string;
  tooling: { repository: string; workflow_path: string; ref: string; sha: string };
  validation: {
    intent: string;
    profile: string;
    soak: boolean;
    allowed_groups: string[];
  };
  inventory: {
    packages: Array<{ name: string; version: string; targets: string[] }>;
    platforms: Array<{ id: string; source: string }>;
  };
};
type ReleasePlanLock = Record<"schema" | "digest", string> & { plan: ReleasePlan };

const REPOSITORY = "openclaw/openclaw";
const EXECUTION_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOTSTRAP_PATH = "scripts/release-plan-producer.mts",
  CORE_PATH = "scripts/release-plan-producer-core.mts";
const TOOLING_MODULE_PATHS = [
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/lib/bounded-response.mjs",
  "scripts/lib/canonical-json.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/plugin-publication-target.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-version.mjs",
  CORE_PATH,
  "scripts/release-plan-contract.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/release-validation-intent.mjs",
] as const;
const PROTECTED_TAG_PATTERN = /^release-publish\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const MAX_TOOLING_FILE_BYTES = 512 * 1024,
  MAX_TOOLING_BYTES = 2 * 1024 * 1024;
const YAML_PACKAGE_TREE_SHA256 = "610ccacfe592d226ac1eb04842d1f591c5381f2a68b9f785643101d10db52c27";
const YAML_PACKAGE_MAX_FILES = 512;
const YAML_PACKAGE_MAX_ENTRIES = 1024;
const YAML_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
const compareAscii = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

type ToolingModule = { path: string; bytes: Buffer; imports: Array<[string, string]> };
type YamlEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; bytes: Buffer };
type SerializableSource = Omit<ReleasePlanSourceBase, "runGh"> & Record<string, unknown>;
type ProducerRequest =
  | { operation: "produce" | "produce-lock"; params: SerializableSource }
  | { operation: "verify-lock"; lockJson: string; params: SerializableSource };

const CHILD_RUNNER = String.raw`
import { createHash } from "node:crypto"; import { readFileSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { deserialize, serialize } from "node:v8";
const TOOLING_ROOT = "file:///__openclaw_verified_tooling__/", YAML_ROOT = "file:///__openclaw_verified_yaml__/";
const YAML_ABSOLUTE_ROOT = "/__openclaw_verified_yaml__", CORE_PATH = ${JSON.stringify(CORE_PATH)};
const EXPECTED_TOOLING_PATHS = ${JSON.stringify(TOOLING_MODULE_PATHS)};
const compareAscii = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const fail = message => { throw new Error(message); };
const toolingUrl = path => new URL(path, TOOLING_ROOT).href, yamlUrl = path => new URL(path, YAML_ROOT).href;
const safePath = path => typeof path === "string" && path.length > 0 &&
  /^[\x20-\x7e]+$/.test(path) && !path.includes("\\") && !path.startsWith("/") &&
  !path.split("/").some(part => part === "." || part === "..");
try {
  const payload = deserialize(readFileSync(0)), expectedPaths = [...EXPECTED_TOOLING_PATHS].sort(compareAscii);
  if (!Array.isArray(payload.toolingModules) || payload.toolingModules.length !== expectedPaths.length) fail("verified tooling module set is incomplete");
  const toolingModules = new Map();
  for (const record of payload.toolingModules) {
    if (!record || !expectedPaths.includes(record.path) || toolingModules.has(record.path) || !Array.isArray(record.imports)) fail("verified tooling module record is invalid");
    toolingModules.set(record.path, { bytes: Buffer.from(record.bytes),
      format: record.path.endsWith(".mjs") ? "module" : "module-typescript",
      imports: new Map(record.imports) });
  }
  if ([...toolingModules.keys()].sort(compareAscii).some((path, index) => path !== expectedPaths[index])) fail("verified tooling module paths do not match the allowlist");
  if (!Array.isArray(payload.yamlEntries) || payload.yamlEntries.length > ${YAML_PACKAGE_MAX_ENTRIES}) fail("verified yaml retained tree has too many entries");
  const yamlModules = new Map(), yamlRecords = []; let yamlFiles = 0, yamlBytes = 0;
  for (const entry of payload.yamlEntries) {
    if (!entry || !safePath(entry.path)) fail("verified yaml retained tree contains an unsafe path");
    if (entry.kind === "directory") {
      yamlRecords.push(JSON.stringify(["directory", entry.path])); continue;
    }
    if (entry.kind !== "file" || yamlModules.has(entry.path)) fail("verified yaml retained tree contains an invalid entry");
    const bytes = Buffer.from(entry.bytes); yamlFiles += 1; yamlBytes += bytes.byteLength;
    if (yamlFiles > ${YAML_PACKAGE_MAX_FILES} || yamlBytes > ${YAML_PACKAGE_MAX_BYTES}) fail("verified yaml retained tree exceeds its bounds");
    yamlModules.set(entry.path, bytes);
    yamlRecords.push(JSON.stringify(["file", entry.path, bytes.byteLength, createHash("sha256").update(bytes).digest("hex")]));
  }
  const yamlManifest = yamlRecords.sort(compareAscii).join("\n") + "\n";
  if (createHash("sha256").update(yamlManifest, "ascii").digest("hex") !== ${JSON.stringify(YAML_PACKAGE_TREE_SHA256)}) fail("verified yaml retained tree digest mismatch");
  const packageBytes = yamlModules.get("package.json");
  if (!packageBytes) fail("verified yaml retained package.json is missing");
  const yamlPackage = JSON.parse(packageBytes.toString("utf8"));
  if (yamlPackage.name !== "yaml" || yamlPackage.version !== "2.9.0") fail("verified yaml retained package identity mismatch");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isBuiltin(specifier)) return nextResolve(specifier, context);
      if (context.parentURL?.startsWith(TOOLING_ROOT)) {
        const parentPath = context.parentURL.slice(TOOLING_ROOT.length);
        const targetPath = toolingModules.get(parentPath)?.imports.get(specifier);
        if (!targetPath) fail("verified tooling import is not allowlisted");
        return { url: toolingUrl(targetPath), format: toolingModules.get(targetPath).format, shortCircuit: true };
      }
      if (specifier === toolingUrl(CORE_PATH)) return { url: specifier, format: toolingModules.get(CORE_PATH).format, shortCircuit: true };
      const targetUrl = specifier.startsWith(YAML_ABSOLUTE_ROOT + "/") ?
        yamlUrl(specifier.slice(YAML_ABSOLUTE_ROOT.length + 1)) :
        context.parentURL?.startsWith(YAML_ROOT) && specifier.startsWith(".") ?
          new URL(specifier, context.parentURL).href : undefined;
      if (targetUrl) {
        const targetPath = targetUrl.slice(YAML_ROOT.length);
        if (!yamlModules.has(targetPath)) fail("verified yaml import is not retained");
        return { url: targetUrl, format: "commonjs", shortCircuit: true };
      }
      fail("verified child rejected an external module import");
    },
    load(url, context, nextLoad) {
      if (url.startsWith(TOOLING_ROOT)) {
        const record = toolingModules.get(url.slice(TOOLING_ROOT.length));
        if (!record) fail("verified tooling module is not retained");
        return { format: record.format, source: record.bytes, shortCircuit: true };
      }
      if (url.startsWith(YAML_ROOT)) {
        const bytes = yamlModules.get(url.slice(YAML_ROOT.length));
        if (!bytes) fail("verified yaml module is not retained");
        return { format: "commonjs", source: bytes, shortCircuit: true };
      }
      if (url.startsWith("node:")) return nextLoad(url, context);
      fail("verified child rejected an external module load");
    },
  });
  const identityResponses = new Map(payload.identityResponses);
  if (identityResponses.size !== 1) fail("verified identity response cache must contain exactly one request");
  const runGh = args => {
    const key = JSON.stringify(args);
    if (!identityResponses.has(key)) fail("verified child rejected an uncached GitHub request");
    return identityResponses.get(key);
  };
  let parseYaml;
  const parseYamlDocuments = sources => {
    if (!Array.isArray(sources) || sources.length !== 3 || sources.some(value => typeof value !== "string")) fail("verified yaml parser input must contain three workflow strings");
    if (!parseYaml) {
      const yaml = createRequire(import.meta.url)(YAML_ABSOLUTE_ROOT + "/dist/index.js");
      if (typeof yaml.parse !== "function") fail("verified yaml parser must export parse"); parseYaml = yaml.parse;
    }
    return sources.map(parseYaml);
  };
  const core = await import(toolingUrl(CORE_PATH)), value = core.runReleasePlanProducerOperation(payload.request, { runGh, parseYamlDocuments });
  process.stdout.write(serialize({ ok: true, value }));
} catch (error) {
  process.stdout.write(serialize({ ok: false, message: error instanceof Error ? error.message : String(error) }));
}
`;

const gitBytes = (repoRoot: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

function requireSha(value: string, label: string) {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-character commit SHA`);
  }
  return value;
}

function defaultRunGh(args: string[]) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function verifyRemoteTooling(params: ReleasePlanSource, runGh: RunGh) {
  const sha = requireSha(params.toolingSha, "tooling SHA");
  const tagRef = params.toolingFullRef.replace(/^refs\/tags\//u, "");
  const protectedMatch = PROTECTED_TAG_PATTERN.exec(tagRef);
  let args: string[], failure: string;
  if (protectedMatch) {
    if (protectedMatch[1] !== sha.slice(0, 12)) {
      throw new Error("protected release tooling tag SHA prefix does not match the workflow SHA");
    }
    args = ["api", `repos/${REPOSITORY}/git/ref/tags/${tagRef}`, "--method", "GET"];
    failure = "protected release tooling tag is missing or unreadable";
  } else if (params.toolingFullRef === "refs/heads/main") {
    // Keep this bounded query identical to the verified child's cached identity request.
    args = [
      "api",
      `repos/${REPOSITORY}/compare/${sha}...main`,
      "--method",
      "GET",
      "--jq",
      "{status}",
    ];
    failure = "main release tooling ancestry could not be verified";
  } else {
    throw new Error("release tooling identity must be trusted main or an exact protected tag");
  }
  let raw: string;
  try {
    raw = runGh(args);
  } catch (error) {
    throw new Error(failure, { cause: error });
  }
  const response = JSON.parse(raw) as {
    ref?: unknown;
    status?: unknown;
    object?: { type?: unknown; sha?: unknown };
  };
  if (
    protectedMatch &&
    (response.ref !== params.toolingFullRef ||
      response.object?.type !== "commit" ||
      response.object.sha !== sha)
  ) {
    throw new Error(
      "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA",
    );
  }
  if (!protectedMatch && response.status !== "ahead" && response.status !== "identical") {
    throw new Error("main release tooling SHA is not reachable from current main");
  }
  if (params.intent !== "diagnostic" && params.intent !== "main-qualification" && !protectedMatch) {
    throw new Error(`${params.intent} tooling must use a release-publish tag bound to its SHA`);
  }
  return [[JSON.stringify(args), raw]] as Array<[string, string]>;
}

function readGitFile(repoRoot: string, sha: string, path: string) {
  const entry = gitBytes(repoRoot, ["ls-tree", sha, "--", path]).toString("utf8").trim();
  if (!/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(entry)) {
    throw new Error(`tooling closure path must be a regular Git blob: ${path}`);
  }
  return gitBytes(repoRoot, ["show", `${sha}:${path}`]);
}

function gitPathExists(repoRoot: string, sha: string, path: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${path}`], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function collectLiteralImports(source: string) {
  return [
    ...new Set(
      [...source.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/gu)].map(
        (match) => match[1]!,
      ),
    ),
  ].toSorted(compareAscii);
}

function resolveImport(repoRoot: string, sha: string, sourcePath: string, specifier: string) {
  if (!specifier.startsWith(".") || specifier.startsWith("file:")) {
    throw new Error(`tooling closure contains an unowned import: ${sourcePath} -> ${specifier}`);
  }
  const importedPath = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  if (importedPath === ".." || importedPath.startsWith("../")) {
    throw new Error(`tooling import escapes repository root: ${sourcePath} -> ${specifier}`);
  }
  const candidates = new Set([importedPath]);
  if (importedPath.endsWith(".js")) {
    candidates.add(`${importedPath.slice(0, -3)}.ts`);
  } else if (importedPath.endsWith(".mjs")) {
    candidates.add(`${importedPath.slice(0, -4)}.mts`);
  } else if (!posix.extname(importedPath)) {
    for (const suffix of [".ts", ".mts", ".mjs", "/index.ts"]) {
      candidates.add(`${importedPath}${suffix}`);
    }
  }
  const existing = [...candidates].filter((path) => gitPathExists(repoRoot, sha, path));
  if (existing.length !== 1) {
    throw new Error(
      `tooling import must resolve to one unambiguous file: ${sourcePath} -> ${specifier}`,
    );
  }
  const [target] = existing;
  if (!target || !TOOLING_MODULE_PATHS.includes(target as (typeof TOOLING_MODULE_PATHS)[number])) {
    throw new Error(`tooling import is outside the fixed closure: ${sourcePath} -> ${specifier}`);
  }
  return target;
}

function retainToolingClosure(repoRoot: string, sha: string) {
  const pending = [CORE_PATH];
  const modules = new Map<string, ToolingModule>();
  let totalBytes = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || modules.has(path)) {
      continue;
    }
    const bytes = readGitFile(repoRoot, sha, path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_TOOLING_FILE_BYTES || totalBytes > MAX_TOOLING_BYTES) {
      throw new Error("tooling closure exceeds its retained-byte bounds");
    }
    const imports: Array<[string, string]> = [];
    for (const specifier of collectLiteralImports(bytes.toString("utf8"))) {
      if (isBuiltin(specifier)) {
        continue;
      }
      const target = resolveImport(repoRoot, sha, path, specifier);
      imports.push([specifier, target]);
      pending.push(target);
    }
    modules.set(path, { path, bytes, imports });
  }
  const retained = [...modules.values()].toSorted((left, right) =>
    compareAscii(left.path, right.path),
  );
  if (
    retained.length !== TOOLING_MODULE_PATHS.length ||
    retained.some(
      (record, index) => record.path !== [...TOOLING_MODULE_PATHS].toSorted(compareAscii)[index],
    )
  ) {
    throw new Error("tooling closure does not match the fixed allowlist");
  }
  return retained;
}

function assertSafeYamlPath(path: string) {
  const components = new Set(path.split("/"));
  if (
    !path ||
    !/^[\x20-\x7e]+$/u.test(path) ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    components.has(".") ||
    components.has("..")
  ) {
    throw new Error(`installed yaml package contains an unsafe path: ${JSON.stringify(path)}`);
  }
}

function retainYamlPackage() {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("installed yaml package verification requires O_NOFOLLOW support");
  }
  const packageRoot = fs.realpathSync(join(EXECUTION_ROOT, "node_modules", "yaml"));
  if (!fs.lstatSync(packageRoot).isDirectory()) {
    throw new Error("installed yaml package root must be a directory");
  }
  const entries: YamlEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (directory: string, relativeDirectory = "") => {
    for (const name of fs.readdirSync(directory).toSorted(compareAscii)) {
      // Installer-created dependencies and bin shims are not package bytes or retained modules.
      if (!relativeDirectory && name === "node_modules") {
        continue;
      }
      const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeYamlPath(path);
      if (entries.length >= YAML_PACKAGE_MAX_ENTRIES) {
        throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_ENTRIES} entries`);
      }
      const absolutePath = join(directory, name);
      const lstat = fs.lstatSync(absolutePath);
      if (lstat.isSymbolicLink()) {
        throw new Error(`installed yaml package must not contain symbolic links: ${path}`);
      }
      if (lstat.isDirectory()) {
        entries.push({ kind: "directory", path });
        walk(absolutePath, path);
        continue;
      }
      if (!lstat.isFile()) {
        throw new Error("installed yaml package must contain only directories and files");
      }
      fileCount += 1;
      if (fileCount > YAML_PACKAGE_MAX_FILES) {
        throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_FILES} files`);
      }
      const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) {
          throw new Error(`installed yaml package file changed type: ${path}`);
        }
        totalBytes += stat.size;
        if (totalBytes > YAML_PACKAGE_MAX_BYTES) {
          throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_BYTES} bytes`);
        }
        bytes = fs.readFileSync(descriptor);
        if (bytes.byteLength !== stat.size) {
          throw new Error(`installed yaml package file changed while being read: ${path}`);
        }
      } finally {
        fs.closeSync(descriptor);
      }
      entries.push({ kind: "file", path, bytes });
    }
  };
  walk(packageRoot);
  return entries;
}

const serializableParams = ({ runGh: _runGh, ...source }: ReleasePlanSource) =>
  source as SerializableSource;

function runOperation(request: ProducerRequest, params: ReleasePlanSource) {
  const repoRoot = resolve(params.repoRoot ?? ".");
  const runGh = params.runGh ?? defaultRunGh;
  const identityResponses = verifyRemoteTooling(params, runGh);
  const toolingSha = requireSha(params.toolingSha, "tooling SHA");
  const executionHead = gitBytes(EXECUTION_ROOT, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (executionHead !== toolingSha) {
    throw new Error("tooling bootstrap checkout HEAD must equal tooling SHA");
  }
  const bootstrapBytes = readGitFile(repoRoot, toolingSha, BOOTSTRAP_PATH);
  if (!fs.readFileSync(fileURLToPath(import.meta.url)).equals(bootstrapBytes)) {
    throw new Error(`tooling bootstrap differs from tooling SHA: ${BOOTSTRAP_PATH}`);
  }
  let stdout: Buffer;
  try {
    stdout = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD_RUNNER], {
      cwd: repoRoot,
      encoding: null,
      env: {},
      input: serialize({
        identityResponses,
        request,
        toolingModules: retainToolingClosure(repoRoot, toolingSha),
        yamlEntries: retainYamlPackage(),
      }),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error("verified release plan child failed", { cause: error });
  }
  const envelope = deserialize(stdout) as { ok?: unknown; value?: unknown; message?: unknown };
  if (envelope.ok !== true) {
    throw new Error(
      typeof envelope.message === "string" ? envelope.message : "verified child failed",
    );
  }
  return envelope.value;
}

export function produceReleasePlan(params: ReleasePlanSource): ReleasePlan {
  return runOperation(
    { operation: "produce", params: serializableParams(params) },
    params,
  ) as ReleasePlan;
}

export function verifyReleasePlanLock(lockJson: string, params: ReleasePlanSource) {
  return runOperation(
    { operation: "verify-lock", lockJson, params: serializableParams(params) },
    params,
  ) as ReleasePlanLock;
}

function requiredOption(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const intent = requiredOption(args, "--intent") as ReleasePlanIntent;
  if (!["publish", "diagnostic", "postpublish-confidence", "main-qualification"].includes(intent)) {
    throw new Error(
      "--intent must be publish, diagnostic, postpublish-confidence, or main-qualification",
    );
  }
  const source = {
    candidateSha: requiredOption(args, "--candidate-sha"),
    candidateRef: requiredOption(args, "--candidate-ref"),
    toolingSha: requiredOption(args, "--tooling-sha"),
    toolingFullRef: requiredOption(args, "--tooling-full-ref"),
  };
  const params = {
    ...source,
    intent,
    ...(intent === "main-qualification"
      ? {
          validationIntent: requiredOption(
            args,
            "--validation-intent",
          ) as MainQualificationValidationIntent,
        }
      : {}),
  } as ReleasePlanSource;
  process.stdout.write(
    runOperation(
      { operation: "produce-lock", params: serializableParams(params) },
      params,
    ) as string,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[release-plan-producer] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
