#!/usr/bin/env -S node --import tsx
// Openclaw Npm Postpublish Verify script supports OpenClaw repository automation.

import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  opendirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  posix as pathPosix,
  relative,
  win32 as pathWin32,
} from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { ALWAYS_ALLOWED_RUNTIME_DIR_NAMES } from "../src/plugin-sdk/facade-activation-contract.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../src/plugins/runtime-sidecar-paths.ts";
import { readBoundedResponseText } from "./lib/bounded-response.ts";
import { listBundledPluginPackArtifacts } from "./lib/bundled-plugin-build-entries.mjs";
import { formatErrorMessage } from "./lib/error-format.mjs";
import { runNpmVerifyCommand } from "./lib/npm-verify-exec.ts";
import {
  collectRuntimeDependencySpecs,
  packageNameFromSpecifier,
} from "./lib/plugin-package-dependencies.mjs";
import { runInstalledWorkspaceBootstrapSmoke } from "./lib/workspace-bootstrap-smoke.mjs";
import { parseReleaseVersion, resolveNpmCommandInvocation } from "./openclaw-npm-release-check.ts";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

type InstalledPackageJson = {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type InstalledBundledExtensionPackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type InstalledBundledExtensionManifestRecord = {
  id: string;
  manifest: InstalledBundledExtensionPackageJson;
  path: string;
};

const MAX_BUNDLED_EXTENSION_MANIFEST_BYTES = 1024 * 1024;
const LEGACY_CONTEXT_ENGINE_UNRESOLVED_RUNTIME_MARKER =
  "Failed to load legacy context engine runtime.";
const PUBLISHED_BUNDLED_RUNTIME_SIDECAR_PATHS = BUNDLED_RUNTIME_SIDECAR_PATHS.filter(
  (relativePath) => listBundledPluginPackArtifacts().includes(relativePath),
);
const NODE_BUILTIN_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
const MAX_INSTALLED_ROOT_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_INSTALLED_ROOT_DIST_JS_BYTES = 6 * 1024 * 1024;
// Keep the dependency scan bounded while allowing headroom for generated root chunks.
const MAX_INSTALLED_ROOT_DIST_JS_FILES = 10_000;
const ROOT_DIST_JAVASCRIPT_MODULE_FILE_RE = /\.(?:c|m)?js$/u;
const OPTIONAL_OR_EXTERNALIZED_RUNTIME_IMPORTS = new Set([
  // Optional A2UI markdown renderer. The Canvas host bundle catches the missing
  // package and falls back when the optional renderer is unavailable.
  "@a2ui/markdown-it",
  "@discordjs/opus",
  "@lancedb/lancedb",
  // Feishu/Lark remains a bundled plugin package. Root dist can retain orphaned
  // lazy chunks from the plugin build even though dist/extensions/feishu is
  // externalized from the root package scan.
  "@larksuiteoapi/node-sdk",
  // Discord remains an official external plugin. The root package can retain
  // orphaned lazy chunks from the plugin build, but the plugin owns prism-media.
  "prism-media",
  "@matrix-org/matrix-sdk-crypto-nodejs",
  "link-preview-js",
  "matrix-js-sdk",
  // Public plugin SDK contract helpers are intentionally test-only entrypoints.
  // Consumers importing them run under their own Vitest dev dependency.
  "vitest",
]);
const require = createRequire(import.meta.url);
const acorn = require("acorn") as typeof import("acorn");

type DistJavaScriptFileListResult =
  | { files: string[]; limitExceeded: false }
  | { files: string[]; limit: number; limitExceeded: true };

type PublishedInstallScenario = {
  name: string;
  installSpecs: string[];
  expectedVersion: string;
};

type OpenClawNpmPostpublishVerifyArgs =
  | {
      help: false;
      version: string;
    }
  | {
      help: true;
      version: "";
    };

export function openClawNpmPostpublishVerifyUsage(): string {
  return "Usage: node --import tsx scripts/openclaw-npm-postpublish-verify.ts <version>";
}

export function parseOpenClawNpmPostpublishVerifyArgs(
  argv: readonly string[],
): OpenClawNpmPostpublishVerifyArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const version = args[0]?.trim() ?? "";
  if (version === "--help" || version === "-h") {
    return { help: true, version: "" };
  }
  if (!version) {
    throw new Error(openClawNpmPostpublishVerifyUsage());
  }
  if (version.startsWith("-")) {
    throw new Error(`Unknown openclaw npm postpublish verifier option: ${version}`);
  }
  const extraArg = args[1]?.trim();
  if (extraArg) {
    throw new Error(`Unexpected openclaw npm postpublish verifier argument: ${extraArg}`);
  }
  return { help: false, version };
}

export function buildPublishedInstallScenarios(version: string): PublishedInstallScenario[] {
  const parsed = parseReleaseVersion(version);
  if (parsed === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }

  const exactSpec = `openclaw@${version}`;
  const scenarios: PublishedInstallScenario[] = [
    {
      name: "fresh-exact",
      installSpecs: [exactSpec],
      expectedVersion: version,
    },
  ];

  if (parsed.channel === "stable" && parsed.correctionNumber !== undefined) {
    scenarios.push({
      name: "upgrade-from-base-stable",
      installSpecs: [`openclaw@${parsed.baseVersion}`, exactSpec],
      expectedVersion: version,
    });
  }

  return scenarios;
}

type NpmRegistryKey = {
  key: string;
  keyid: string;
};

type NpmRegistrySignature = {
  keyid: string;
  sig: string;
};

type NpmRegistryAttestation = {
  bundle?: {
    dsseEnvelope?: {
      payload?: string;
    };
  };
  predicateType?: string;
};

type NpmProvenanceVerificationPolicy = {
  certificateIdentityURI: string;
  certificateIssuer: string;
};

type VerifyNpmProvenanceBundle = (
  bundle: unknown,
  policy: NpmProvenanceVerificationPolicy,
) => Promise<void>;

type NpmProvenanceStatement = {
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: {
          path?: string;
          ref?: string;
          repository?: string;
        };
      };
      resolvedDependencies?: Array<{
        digest?: {
          gitCommit?: string;
        };
        uri?: string;
      }>;
    };
    runDetails?: {
      builder?: {
        id?: string;
      };
    };
  };
  subject?: Array<{
    digest?: Record<string, string>;
    name?: string;
  }>;
};

const NPM_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const NPM_PROVENANCE_REPOSITORY = "https://github.com/openclaw/openclaw";
const NPM_PROVENANCE_WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";
const NPM_PROVENANCE_CERTIFICATE_ISSUER = "https://token.actions.githubusercontent.com";
const NPM_PROVENANCE_BUILDER_ID = "https://github.com/actions/runner/github-hosted";
const NPM_REGISTRY_REQUEST_TIMEOUT_MS = 30_000;
const NPM_REGISTRY_RESPONSE_BODY_MAX_BYTES = 4 * 1024 * 1024;
const NPM_REGISTRY_PROVENANCE_ATTEMPTS = 30;
const NPM_REGISTRY_PROVENANCE_RETRY_MAX_DELAY_MS = 10_000;

type FetchRegistryJsonOptions = {
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

export function verifyNpmRegistrySignatures(params: {
  integrity: string;
  keys: NpmRegistryKey[];
  packageName: string;
  signatures: NpmRegistrySignature[];
  version: string;
}): void {
  if (!params.integrity.startsWith("sha512-")) {
    throw new Error(`npm registry integrity is missing a sha512 digest for ${params.packageName}.`);
  }
  if (params.signatures.length === 0) {
    throw new Error(
      `npm registry returned no signatures for ${params.packageName}@${params.version}.`,
    );
  }

  const payload = `${params.packageName}@${params.version}:${params.integrity}`;
  for (const signature of params.signatures) {
    const key = params.keys.find((candidate) => candidate.keyid === signature.keyid);
    if (!key) {
      continue;
    }
    const publicKey = createPublicKey({
      key: Buffer.from(key.key, "base64"),
      format: "der",
      type: "spki",
    });
    if (
      verifySignature(
        "sha256",
        Buffer.from(payload, "utf8"),
        publicKey,
        Buffer.from(signature.sig, "base64"),
      )
    ) {
      return;
    }
  }

  throw new Error(
    `npm registry signatures did not verify for ${params.packageName}@${params.version}.`,
  );
}

function resolveNpmProvenanceVerificationPolicy(
  statement: NpmProvenanceStatement,
  version: string,
  expectedWorkflow?: {
    ref?: string;
    sha?: string;
  },
): NpmProvenanceVerificationPolicy {
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const workflowRef = workflow?.ref;
  const expectedReleaseRef = `refs/heads/release/${parsedVersion.baseVersion}`;
  // A month's final patch >=33 releases stay on its canonical .33 maintenance branch.
  const isExpectedExtendedStableRef =
    parsedVersion.channel === "stable" &&
    parsedVersion.correctionNumber === undefined &&
    parsedVersion.patch >= 33 &&
    workflowRef === `refs/heads/extended-stable/${parsedVersion.year}.${parsedVersion.month}.33`;
  const protectedReleasePublishMatch =
    /^refs\/tags\/release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u.exec(workflowRef ?? "");
  let protectedReleasePublishTrusted = false;
  if (protectedReleasePublishMatch) {
    const expectedRef = expectedWorkflow?.ref;
    const expectedSha = expectedWorkflow?.sha;
    if (
      expectedRef !== workflowRef ||
      !/^[a-f0-9]{40}$/u.test(expectedSha ?? "") ||
      expectedSha?.slice(0, 12) !== protectedReleasePublishMatch[1]
    ) {
      throw new Error(
        "npm provenance SHA-pinned release-publish ref does not match the approved workflow ref and SHA.",
      );
    }
    const expectedDependencyUri = `git+${NPM_PROVENANCE_REPOSITORY}@${workflowRef}`;
    protectedReleasePublishTrusted =
      statement.predicate?.buildDefinition?.resolvedDependencies?.some(
        (dependency) =>
          dependency.uri === expectedDependencyUri && dependency.digest?.gitCommit === expectedSha,
      ) === true;
    if (!protectedReleasePublishTrusted) {
      throw new Error(
        "npm provenance does not bind the approved SHA-pinned release-publish ref to its workflow revision.",
      );
    }
  }
  const isTrustedRef =
    workflowRef === "refs/heads/main" ||
    workflowRef === expectedReleaseRef ||
    isExpectedExtendedStableRef ||
    protectedReleasePublishTrusted ||
    (parsedVersion.channel === "alpha" &&
      /^refs\/heads\/tideclaw\/alpha\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z$/u.test(
        workflowRef ?? "",
      ));

  if (
    workflow?.repository !== NPM_PROVENANCE_REPOSITORY ||
    workflow?.path !== NPM_PROVENANCE_WORKFLOW_PATH ||
    !isTrustedRef ||
    statement.predicate?.runDetails?.builder?.id !== NPM_PROVENANCE_BUILDER_ID
  ) {
    throw new Error(
      `npm provenance attestation does not bind ${version} to the trusted OpenClaw GitHub release workflow.`,
    );
  }

  return {
    certificateIssuer: NPM_PROVENANCE_CERTIFICATE_ISSUER,
    certificateIdentityURI: `${NPM_PROVENANCE_REPOSITORY}/${NPM_PROVENANCE_WORKFLOW_PATH}@${workflowRef}`,
  };
}

async function verifySigstoreNpmProvenanceBundle(
  bundle: unknown,
  policy: NpmProvenanceVerificationPolicy,
): Promise<void> {
  const sigstore = require("sigstore") as { verify: VerifyNpmProvenanceBundle };
  await sigstore.verify(bundle, policy);
}

export async function verifyNpmProvenanceAttestation(params: {
  attestations: NpmRegistryAttestation[];
  expectedWorkflowRef?: string;
  expectedWorkflowSha?: string;
  integrity: string;
  packageName: string;
  verifyBundle?: VerifyNpmProvenanceBundle;
  version: string;
}): Promise<void> {
  const expectedSubject = `pkg:npm/${params.packageName}@${params.version}`;
  const expectedSha512 = Buffer.from(params.integrity.slice("sha512-".length), "base64").toString(
    "hex",
  );
  const verifyBundle = params.verifyBundle ?? verifySigstoreNpmProvenanceBundle;
  let verificationError: unknown;
  let policyError: unknown;

  for (const attestation of params.attestations) {
    if (attestation.predicateType !== NPM_PROVENANCE_PREDICATE_TYPE) {
      continue;
    }
    const payload = attestation.bundle?.dsseEnvelope?.payload;
    if (!payload) {
      continue;
    }
    try {
      const statement = JSON.parse(
        Buffer.from(payload, "base64").toString("utf8"),
      ) as NpmProvenanceStatement;
      if (
        statement.subject?.some(
          (subject) =>
            subject.name === expectedSubject && subject.digest?.sha512 === expectedSha512,
        )
      ) {
        let policy: NpmProvenanceVerificationPolicy;
        try {
          policy = resolveNpmProvenanceVerificationPolicy(statement, params.version, {
            ref: params.expectedWorkflowRef,
            sha: params.expectedWorkflowSha,
          });
        } catch (error) {
          policyError = error;
          continue;
        }
        try {
          await verifyBundle(attestation.bundle, policy);
          return;
        } catch (error) {
          verificationError = error;
        }
      }
    } catch {
      // Try the remaining attestations before reporting the missing match.
    }
  }

  if (verificationError) {
    throw new Error(
      `npm provenance attestation failed Sigstore verification for ${params.packageName}@${params.version}: ${formatErrorMessage(verificationError)}`,
    );
  }

  if (policyError instanceof Error) {
    throw policyError;
  }
  if (policyError) {
    throw new Error(
      `npm provenance attestation policy evaluation failed for ${params.packageName}@${params.version}: ${formatErrorMessage(policyError)}`,
    );
  }

  throw new Error(
    `npm provenance attestation does not match ${params.packageName}@${params.version} and its registry integrity.`,
  );
}

export function collectInstalledPackageErrors(params: {
  expectedVersion: string;
  installedVersion: string;
  packageRoot: string;
}): string[] {
  const errors: string[] = [];
  const installedVersion = normalizeInstalledBinaryVersion(params.installedVersion);

  if (installedVersion !== params.expectedVersion) {
    errors.push(
      `installed package version mismatch: expected ${params.expectedVersion}, found ${params.installedVersion || "<missing>"}.`,
    );
  }

  for (const relativePath of collectInstalledBundledRuntimeSidecarPaths(params.packageRoot)) {
    if (!existsSync(join(params.packageRoot, relativePath))) {
      errors.push(`installed package is missing required bundled runtime sidecar: ${relativePath}`);
    }
  }

  errors.push(...collectInstalledBundledExtensionManifestErrors(params.packageRoot));
  errors.push(...collectInstalledAlwaysAllowedRuntimeFacadeErrors(params.packageRoot));
  errors.push(...collectInstalledContextEngineRuntimeErrors(params.packageRoot));
  errors.push(...collectInstalledPluginSdkZodArtifactErrors(params.packageRoot));
  errors.push(...collectInstalledPluginSdkDeclarationErrors(params.packageRoot));
  errors.push(...collectInstalledRootDependencyManifestErrors(params.packageRoot));

  return errors;
}

export function collectInstalledAlwaysAllowedRuntimeFacadeErrors(packageRoot: string): string[] {
  const errors: string[] = [];
  const activationRuntimePath = "dist/facade-activation-check.runtime.js";
  if (!existsSync(join(packageRoot, activationRuntimePath))) {
    errors.push(
      `installed package is missing required facade activation runtime: ${activationRuntimePath}`,
    );
  }
  for (const dirName of ALWAYS_ALLOWED_RUNTIME_DIR_NAMES) {
    const relativePath = `dist/extensions/${dirName}/runtime-api.js`;
    if (!existsSync(join(packageRoot, relativePath))) {
      errors.push(
        `installed package allows bundled runtime facade ${dirName}/runtime-api.js but is missing required runtime sidecar: ${relativePath}.`,
      );
    }
  }
  return errors;
}

function collectInstalledBundledExtensionIds(packageRoot: string): Set<string> {
  const extensionsDir = join(packageRoot, "dist", "extensions");
  if (!existsSync(extensionsDir)) {
    return new Set();
  }
  const ids = new Set<string>();
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (existsSync(join(extensionsDir, entry.name, "package.json"))) {
      ids.add(entry.name);
    }
  }
  return ids;
}

export function collectInstalledBundledRuntimeSidecarPaths(packageRoot: string): string[] {
  const installedExtensionIds = collectInstalledBundledExtensionIds(packageRoot);
  return PUBLISHED_BUNDLED_RUNTIME_SIDECAR_PATHS.filter((relativePath) => {
    const match = /^dist\/extensions\/([^/]+)\//u.exec(relativePath);
    return (
      match !== null &&
      installedExtensionIds.has(expectDefined(match[1], "bundled runtime extension id"))
    );
  });
}

export function collectInstalledBundledExtensionManifestErrors(packageRoot: string): string[] {
  return readBundledExtensionPackageJsons(packageRoot).errors;
}

export function normalizeInstalledBinaryVersion(output: string): string {
  const trimmed = output.trim();
  const versionMatch = /\b\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+|-(?:alpha|beta)\.\d+)?\b/u.exec(trimmed);
  return versionMatch?.[0] ?? trimmed;
}

function listDistJavaScriptFiles(
  packageRoot: string,
  opts: {
    maxFiles?: number;
    skipRelativePath?: (relativePath: string) => boolean;
  } = {},
): DistJavaScriptFileListResult {
  const distDir = join(packageRoot, "dist");
  if (!existsSync(distDir)) {
    return { files: [], limitExceeded: false };
  }

  const pending = [distDir];
  const files: string[] = [];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }
    const dir = opendirSync(currentDir);
    try {
      while (true) {
        const entry = dir.readSync();
        if (!entry) {
          break;
        }

        const entryPath = join(currentDir, entry.name);
        const relativePath = relative(distDir, entryPath).replaceAll("\\", "/");
        if (opts.skipRelativePath?.(relativePath)) {
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (entry.isFile() && ROOT_DIST_JAVASCRIPT_MODULE_FILE_RE.test(entry.name)) {
          files.push(entryPath);
          if (opts.maxFiles !== undefined && files.length > opts.maxFiles) {
            return {
              files,
              limit: opts.maxFiles,
              limitExceeded: true,
            };
          }
        }
      }
    } finally {
      dir.closeSync();
    }
  }

  return { files, limitExceeded: false };
}

function formatInstalledDistFileScanLimitError(scope: string, limit: number): string {
  return `installed package ${scope} contains more than ${limit} JavaScript files; refusing to scan unbounded package contents.`;
}

export function collectInstalledContextEngineRuntimeErrors(packageRoot: string): string[] {
  const errors: string[] = [];
  const distFiles = listDistJavaScriptFiles(packageRoot, {
    maxFiles: MAX_INSTALLED_ROOT_DIST_JS_FILES,
  });
  if (distFiles.limitExceeded) {
    return [formatInstalledDistFileScanLimitError("dist", distFiles.limit)];
  }

  for (const filePath of distFiles.files) {
    const contents = readFileSync(filePath, "utf8");
    if (contents.includes(LEGACY_CONTEXT_ENGINE_UNRESOLVED_RUNTIME_MARKER)) {
      errors.push(
        "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
      );
      break;
    }
  }
  return errors;
}

function resolveInstalledDistRelativeImport(params: {
  distRoot: string;
  importerPath: string;
  specifier: string;
}): string | null {
  if (!params.specifier.startsWith(".")) {
    return null;
  }

  const candidatePath = join(dirname(params.importerPath), params.specifier);
  const candidatePaths = [
    candidatePath,
    `${candidatePath}.js`,
    `${candidatePath}.mjs`,
    `${candidatePath}.cjs`,
    join(candidatePath, "index.js"),
    join(candidatePath, "index.mjs"),
    join(candidatePath, "index.cjs"),
  ];

  for (const resolvedPath of candidatePaths) {
    const relativePath = relative(params.distRoot, resolvedPath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath) ||
      !existsSync(resolvedPath)
    ) {
      continue;
    }
    return resolvedPath;
  }

  return null;
}

export function collectInstalledPluginSdkZodArtifactErrors(packageRoot: string): string[] {
  const distRoot = join(packageRoot, "dist");
  const entryRelativePath = "dist/plugin-sdk/zod.js";
  const entryPath = join(packageRoot, entryRelativePath);
  const pending = [entryPath];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);

    if (!existsSync(filePath)) {
      return [`installed package is missing required plugin SDK artifact: ${entryRelativePath}`];
    }

    const relativePath = relative(packageRoot, filePath).replaceAll("\\", "/");
    const fileStat = lstatSync(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_INSTALLED_ROOT_DIST_JS_BYTES) {
      return [
        `installed package plugin SDK artifact '${relativePath}' is invalid or exceeds ${MAX_INSTALLED_ROOT_DIST_JS_BYTES} bytes.`,
      ];
    }

    const source = readFileSync(filePath, "utf8");
    const parsedSpecifiers = extractJavaScriptImportSpecifiers(source);
    if (!parsedSpecifiers.ok) {
      return [
        `installed package plugin SDK artifact '${relativePath}' could not be parsed for runtime dependency verification: ${parsedSpecifiers.error}.`,
      ];
    }

    for (const specifier of parsedSpecifiers.specifiers) {
      if (specifier === "zod" || specifier.startsWith("zod/")) {
        return [
          `installed package plugin SDK zod artifact must be self-contained but ${relativePath} imports ${specifier}.`,
        ];
      }

      const resolvedPath = resolveInstalledDistRelativeImport({
        distRoot,
        importerPath: filePath,
        specifier,
      });
      if (resolvedPath) {
        pending.push(resolvedPath);
      }
    }
  }

  return [];
}

function collectInstalledPluginSdkDeclarationErrors(packageRoot: string): string[] {
  const pluginSdkDistRoot = join(packageRoot, "dist", "plugin-sdk");
  const errors: string[] = [];
  const forbiddenPrivateWorkspaceSpecifiers = ["@openclaw/llm-core"];

  if (!existsSync(pluginSdkDistRoot)) {
    return [];
  }

  for (const entry of readdirSync(pluginSdkDistRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) {
      continue;
    }

    const relativePath = `dist/plugin-sdk/${entry.name}`;
    const content = readFileSync(join(pluginSdkDistRoot, entry.name), "utf8");
    for (const specifier of forbiddenPrivateWorkspaceSpecifiers) {
      if (content.includes(`"${specifier}`) || content.includes(`'${specifier}`)) {
        errors.push(
          `installed package plugin SDK declaration '${relativePath}' references private workspace package ${specifier}.`,
        );
      }
    }
  }

  return errors;
}

function listInstalledRootDistJavaScriptFiles(packageRoot: string): DistJavaScriptFileListResult {
  return listDistJavaScriptFiles(packageRoot, {
    maxFiles: MAX_INSTALLED_ROOT_DIST_JS_FILES,
    skipRelativePath: (relativePath) =>
      relativePath === "extensions" || relativePath.startsWith("extensions/"),
  });
}

type ParsedImportSpecifiersResult =
  | { ok: true; specifiers: Set<string> }
  | { ok: false; error: string };

function extractLiteralSpecifier(node: unknown): string | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  const candidate = node as { type?: string; value?: unknown };
  if (candidate.type === "Literal" && typeof candidate.value === "string") {
    return candidate.value;
  }
  return null;
}

function extractJavaScriptImportSpecifiers(source: string): ParsedImportSpecifiersResult {
  const specifiers = new Set<string>();
  let program: unknown;
  try {
    program = acorn.parse(source, {
      allowHashBang: true,
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }

  const visited = new Set<unknown>();
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const node = current as Record<string, unknown>;
    const nodeType = typeof node.type === "string" ? node.type : null;

    if (nodeType === "ImportDeclaration") {
      const specifier = extractLiteralSpecifier(node.source);
      if (specifier) {
        specifiers.add(specifier);
      }
    } else if (nodeType === "ExportAllDeclaration" || nodeType === "ExportNamedDeclaration") {
      const specifier = extractLiteralSpecifier(node.source);
      if (specifier) {
        specifiers.add(specifier);
      }
    } else if (nodeType === "ImportExpression") {
      const specifier = extractLiteralSpecifier(node.source);
      if (specifier) {
        specifiers.add(specifier);
      }
    } else if (nodeType === "CallExpression") {
      const callee = node.callee as { type?: string; name?: string } | undefined;
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (callee?.type === "Identifier" && callee.name === "require" && args.length === 1) {
        const specifier = extractLiteralSpecifier(args[0]);
        if (specifier) {
          specifiers.add(specifier);
        }
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }

  return { ok: true, specifiers };
}

export function collectInstalledRootDependencyManifestErrors(packageRoot: string): string[] {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return ["installed package is missing package.json."];
  }
  const packageJsonStat = lstatSync(packageJsonPath);
  if (!packageJsonStat.isFile() || packageJsonStat.size > MAX_INSTALLED_ROOT_PACKAGE_JSON_BYTES) {
    return [
      `installed package.json is invalid or exceeds ${MAX_INSTALLED_ROOT_PACKAGE_JSON_BYTES} bytes.`,
    ];
  }
  let rootPackageJson: InstalledPackageJson;
  try {
    rootPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as InstalledPackageJson;
  } catch (error) {
    return [`installed package.json could not be parsed: ${formatErrorMessage(error)}.`];
  }
  const declaredRuntimeDeps = new Set([
    ...Object.keys(rootPackageJson.dependencies ?? {}),
    ...Object.keys(rootPackageJson.optionalDependencies ?? {}),
  ]);
  const distFiles = listInstalledRootDistJavaScriptFiles(packageRoot);
  if (distFiles.limitExceeded) {
    return [formatInstalledDistFileScanLimitError("root dist", distFiles.limit)];
  }
  const missingImporters = new Map<string, Set<string>>();
  const bundledExtensionRuntimeDependencyOwners =
    collectBundledExtensionRuntimeDependencyOwners(packageRoot);

  for (const filePath of distFiles.files) {
    const fileStat = lstatSync(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_INSTALLED_ROOT_DIST_JS_BYTES) {
      const relativePath = relative(join(packageRoot, "dist"), filePath).replaceAll("\\", "/");
      return [
        `installed package root dist file '${relativePath}' is invalid or exceeds ${MAX_INSTALLED_ROOT_DIST_JS_BYTES} bytes.`,
      ];
    }
    const source = readFileSync(filePath, "utf8");
    const relativePath = relative(join(packageRoot, "dist"), filePath).replaceAll("\\", "/");
    const parsedSpecifiers = extractJavaScriptImportSpecifiers(source);
    if (!parsedSpecifiers.ok) {
      return [
        `installed package root dist file '${relativePath}' could not be parsed for runtime dependency verification: ${parsedSpecifiers.error}.`,
      ];
    }
    for (const specifier of parsedSpecifiers.specifiers) {
      const dependencyName = packageNameFromSpecifier(specifier);
      if (
        !dependencyName ||
        NODE_BUILTIN_MODULES.has(dependencyName) ||
        OPTIONAL_OR_EXTERNALIZED_RUNTIME_IMPORTS.has(dependencyName) ||
        declaredRuntimeDeps.has(dependencyName) ||
        isBundledExtensionOwnedRuntimeImport({
          dependencyName,
          ownersByDependency: bundledExtensionRuntimeDependencyOwners,
          source,
        })
      ) {
        continue;
      }
      const importers = missingImporters.get(dependencyName) ?? new Set<string>();
      importers.add(relativePath);
      missingImporters.set(dependencyName, importers);
    }
  }

  return [...missingImporters.entries()]
    .map(([dependencyName, importers]) => {
      const importerList = [...importers].toSorted((left, right) => left.localeCompare(right));
      return `installed package root is missing declared runtime dependency '${dependencyName}' for dist importers: ${importerList.join(", ")}. Add it to package.json dependencies/optionalDependencies.`;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function collectBundledExtensionRuntimeDependencyOwners(
  packageRoot: string,
): Map<string, Set<string>> {
  const ownersByDependency = new Map<string, Set<string>>();
  const { manifests } = readBundledExtensionPackageJsons(packageRoot);
  for (const { id, manifest } of manifests) {
    for (const dependencyName of collectRuntimeDependencySpecs(manifest).keys()) {
      const owners = ownersByDependency.get(dependencyName) ?? new Set<string>();
      owners.add(id);
      ownersByDependency.set(dependencyName, owners);
    }
  }
  return ownersByDependency;
}

function isBundledExtensionOwnedRuntimeImport(params: {
  dependencyName: string;
  ownersByDependency: Map<string, Set<string>>;
  source: string;
}): boolean {
  const owners = params.ownersByDependency.get(params.dependencyName);
  if (!owners) {
    return false;
  }
  return [...owners].some((pluginId) =>
    params.source.includes(`//#region extensions/${pluginId}/`),
  );
}

export function resolveInstalledBinaryPath(prefixDir: string, platform = process.platform): string {
  return platform === "win32"
    ? pathWin32.join(prefixDir, "openclaw.cmd")
    : pathPosix.join(prefixDir, "bin", "openclaw");
}

export function resolveInstalledBinaryCommandInvocation(
  prefixDir: string,
  args: string[],
  params: { comSpec?: string; platform?: NodeJS.Platform } = {},
): {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
} {
  const platform = params.platform ?? process.platform;
  const binaryPath = resolveInstalledBinaryPath(prefixDir, platform);
  if (platform === "win32") {
    return {
      command: params.comSpec ?? resolveWindowsCmdExePath(),
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(binaryPath, args)],
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: binaryPath,
    args,
  };
}

function collectExpectedBundledExtensionPackageIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const relativePath of listBundledPluginPackArtifacts()) {
    const match = /^dist\/extensions\/([^/]+)\/package\.json$/u.exec(relativePath);
    if (match) {
      ids.add(expectDefined(match[1], "bundled package extension id"));
    }
  }
  return ids;
}

function readBundledExtensionPackageJsons(packageRoot: string): {
  manifests: InstalledBundledExtensionManifestRecord[];
  errors: string[];
} {
  const extensionsDir = join(packageRoot, "dist", "extensions");
  if (!existsSync(extensionsDir)) {
    return { manifests: [], errors: [] };
  }

  const manifests: InstalledBundledExtensionManifestRecord[] = [];
  const errors: string[] = [];
  const expectedPackageIds = collectExpectedBundledExtensionPackageIds();

  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const extensionDirPath = join(extensionsDir, entry.name);
    const packageJsonPath = join(extensionsDir, entry.name, "package.json");
    if (!existsSync(packageJsonPath)) {
      if (expectedPackageIds.has(entry.name)) {
        errors.push(`installed bundled extension manifest missing: ${packageJsonPath}.`);
      }
      continue;
    }

    try {
      const packageJsonStats = lstatSync(packageJsonPath);
      if (!packageJsonStats.isFile()) {
        throw new Error("manifest must be a regular file");
      }
      if (packageJsonStats.size > MAX_BUNDLED_EXTENSION_MANIFEST_BYTES) {
        throw new Error(`manifest exceeds ${MAX_BUNDLED_EXTENSION_MANIFEST_BYTES} bytes`);
      }

      const realExtensionDirPath = realpathSync(extensionDirPath);
      const realPackageJsonPath = realpathSync(packageJsonPath);
      const relativeManifestPath = relative(realExtensionDirPath, realPackageJsonPath);
      if (
        relativeManifestPath.length === 0 ||
        relativeManifestPath.startsWith("..") ||
        isAbsolute(relativeManifestPath)
      ) {
        throw new Error("manifest resolves outside the bundled extension directory");
      }

      manifests.push({
        id: entry.name,
        manifest: JSON.parse(
          readFileSync(realPackageJsonPath, "utf8"),
        ) as InstalledBundledExtensionPackageJson,
        path: realPackageJsonPath,
      });
    } catch (error) {
      errors.push(
        `installed bundled extension manifest invalid: failed to parse ${packageJsonPath}: ${formatErrorMessage(error)}.`,
      );
    }
  }

  return { manifests, errors };
}

function npmExec(args: string[], cwd: string): string {
  const invocation = resolveNpmCommandInvocation({
    npmArgs: args,
    npmExecPath: process.env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform,
  });

  return runNpmVerifyCommand(invocation, cwd);
}

function resolveGlobalRoot(prefixDir: string, cwd: string): string {
  return npmExec(["root", "-g", "--prefix", prefixDir], cwd);
}

export function buildPublishedInstallCommandArgs(prefixDir: string, spec: string): string[] {
  return ["install", "-g", "--prefix", prefixDir, spec, "--no-fund", "--no-audit"];
}

function installSpec(prefixDir: string, spec: string, cwd: string): void {
  npmExec(buildPublishedInstallCommandArgs(prefixDir, spec), cwd);
}

export async function fetchRegistryJson(
  url: string,
  options: FetchRegistryJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? NPM_REGISTRY_REQUEST_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? NPM_REGISTRY_RESPONSE_BODY_MAX_BYTES;
  const controller = new AbortController();
  const timeoutError = Object.assign(
    new Error(`npm registry request timed out after ${timeoutMs}ms: ${url}`),
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
        headers: {
          Accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      throw new Error(`npm registry request failed (${response.status}): ${url}`);
    }
    return JSON.parse(
      await readBoundedResponseText(response, `npm registry ${url}`, maxBodyBytes, {
        signal: controller.signal,
        timeoutPromise,
      }),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableRegistryProvenanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /npm registry request failed \((?:404|408|425|429|5\d\d)\)/u.test(message) ||
    message.includes("npm registry metadata is incomplete") ||
    message.includes("npm registry provenance metadata is incomplete") ||
    message.includes("npm provenance attestation does not bind") ||
    /aborted|fetch failed|network|timeout|timed out/u.test(message)
  );
}

export async function retryNpmRegistryProvenanceRead<T>(
  read: () => Promise<T>,
  options: {
    attempts?: number;
    delay?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? NPM_REGISTRY_PROVENANCE_ATTEMPTS;
  const delay =
    options.delay ??
    ((delayMs: number) =>
      new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, delayMs);
      }));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isRetryableRegistryProvenanceError(error) || attempt === attempts) {
        throw error;
      }
      await delay(Math.min(attempt * 1000, NPM_REGISTRY_PROVENANCE_RETRY_MAX_DELAY_MS));
    }
  }

  throw lastError;
}

async function verifyPublishedRegistryProvenanceOnce(version: string): Promise<void> {
  const registry = new URL(process.env.npm_config_registry ?? "https://registry.npmjs.org");
  if (registry.protocol !== "https:") {
    throw new Error(`npm registry must use HTTPS: ${registry}`);
  }
  if (!registry.pathname.endsWith("/")) {
    registry.pathname = `${registry.pathname}/`;
  }
  const packageName = "openclaw";
  const packageDocument = (await fetchRegistryJson(
    new URL(
      `${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      registry,
    ).toString(),
  )) as {
    dist?: {
      attestations?: {
        provenance?: {
          predicateType?: string;
        };
        url?: string;
      };
      integrity?: string;
      signatures?: NpmRegistrySignature[];
    };
  };
  const keysDocument = (await fetchRegistryJson(new URL("-/npm/v1/keys", registry).toString())) as {
    keys?: NpmRegistryKey[];
  };
  const integrity = packageDocument.dist?.integrity;
  const signatures = packageDocument.dist?.signatures;
  const provenance = packageDocument.dist?.attestations?.provenance;
  const attestationUrl = packageDocument.dist?.attestations?.url;
  if (!integrity || !signatures || !keysDocument.keys) {
    throw new Error(`npm registry metadata is incomplete for ${packageName}@${version}.`);
  }
  if (
    provenance?.predicateType !== NPM_PROVENANCE_PREDICATE_TYPE ||
    typeof attestationUrl !== "string" ||
    attestationUrl.length === 0
  ) {
    throw new Error(
      `npm registry provenance metadata is incomplete for ${packageName}@${version}.`,
    );
  }
  const parsedAttestationUrl = new URL(attestationUrl);
  const attestationPathPrefix = new URL("-/npm/v1/attestations/", registry).pathname;
  if (
    parsedAttestationUrl.protocol !== "https:" ||
    parsedAttestationUrl.origin !== registry.origin ||
    !parsedAttestationUrl.pathname.startsWith(attestationPathPrefix)
  ) {
    throw new Error(
      `npm registry returned an untrusted provenance attestation URL for ${packageName}@${version}.`,
    );
  }

  verifyNpmRegistrySignatures({
    packageName,
    version,
    integrity,
    signatures,
    keys: keysDocument.keys,
  });
  const attestationDocument = (await fetchRegistryJson(parsedAttestationUrl.toString())) as {
    attestations?: NpmRegistryAttestation[];
  };
  const attestations = attestationDocument.attestations ?? [];
  if (attestations.length === 0) {
    throw new Error(
      `npm registry provenance metadata is incomplete for ${packageName}@${version}.`,
    );
  }
  await verifyNpmProvenanceAttestation({
    packageName,
    version,
    integrity,
    attestations,
    expectedWorkflowRef: process.env.OPENCLAW_NPM_EXPECTED_WORKFLOW_REF,
    expectedWorkflowSha: process.env.OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA,
  });
  console.log(
    `openclaw-npm-postpublish-verify: registry signature and provenance attestation verified (${version})`,
  );
}

async function verifyPublishedRegistryProvenance(version: string): Promise<void> {
  await retryNpmRegistryProvenanceRead(() => verifyPublishedRegistryProvenanceOnce(version));
}

function readInstalledBinaryVersion(prefixDir: string, cwd: string): string {
  const invocation = resolveInstalledBinaryCommandInvocation(prefixDir, ["--version"]);
  return runNpmVerifyCommand(invocation, cwd);
}

function verifyScenario(version: string, scenario: PublishedInstallScenario): void {
  const workingDir = mkdtempSync(join(tmpdir(), `openclaw-postpublish-${scenario.name}.`));
  const prefixDir = join(workingDir, "prefix");

  try {
    for (const spec of scenario.installSpecs) {
      installSpec(prefixDir, spec, workingDir);
    }

    const globalRoot = resolveGlobalRoot(prefixDir, workingDir);
    const packageRoot = join(globalRoot, "openclaw");
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as InstalledPackageJson;
    const errors = collectInstalledPackageErrors({
      expectedVersion: scenario.expectedVersion,
      installedVersion: pkg.version?.trim() ?? "",
      packageRoot,
    });
    const installedBinaryVersion = readInstalledBinaryVersion(prefixDir, workingDir);

    if (normalizeInstalledBinaryVersion(installedBinaryVersion) !== scenario.expectedVersion) {
      errors.push(
        `installed openclaw binary version mismatch: expected ${scenario.expectedVersion}, found ${installedBinaryVersion || "<missing>"}.`,
      );
    }

    if (errors.length === 0) {
      runInstalledWorkspaceBootstrapSmoke({ packageRoot });
    }

    if (errors.length > 0) {
      throw new Error(`${scenario.name} failed:\n- ${errors.join("\n- ")}`);
    }

    console.log(`openclaw-npm-postpublish-verify: ${scenario.name} OK (${version})`);
  } finally {
    rmSync(workingDir, { force: true, recursive: true });
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseOpenClawNpmPostpublishVerifyArgs(argv);
  if (args.help) {
    console.log(openClawNpmPostpublishVerifyUsage());
    return;
  }

  const { version } = args;
  const scenarios = buildPublishedInstallScenarios(version);
  await verifyPublishedRegistryProvenance(version);
  for (const scenario of scenarios) {
    verifyScenario(version, scenario);
  }

  console.log(
    `openclaw-npm-postpublish-verify: verified published npm install paths for ${version}.`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint !== null && import.meta.url === entrypoint) {
  try {
    await main();
  } catch (error) {
    console.error(`openclaw-npm-postpublish-verify: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
