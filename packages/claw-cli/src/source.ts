import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  isCanonicalClawHubPackageName,
  isExactSemVer,
  isSafeClawRelativePath,
  parseClawManifest,
  portableClawPathKey,
} from "@openclaw/claw-spec";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { isScalar, parseDocument, visit } from "yaml";
import { CliError } from "./errors.js";
import type { LocalClawPackage } from "./types.js";

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_PACKAGE_FILES = 4_096;

type LoadedFile = { path: string; bytes: Buffer; text?: string };

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function loadPackageFile(
  sourceRoot: Root,
  packagePath: string,
  maxBytes = MAX_PACKAGE_BYTES,
): Promise<LoadedFile | undefined> {
  if (!isSafeClawRelativePath(packagePath)) {
    throw new CliError({
      code: "unsafe_package_path",
      phase: "source",
      message: "Package file paths must be portable and package-relative.",
      path: packagePath,
    });
  }
  const normalizedPath = packagePath.replaceAll("\\", "/");
  try {
    const result = await sourceRoot.read(normalizedPath, {
      hardlinks: "reject",
      maxBytes,
      nonBlockingRead: true,
      symlinks: "reject",
    });
    return { path: normalizedPath, bytes: result.buffer, text: decodeUtf8(result.buffer) };
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return undefined;
    }
    if (error instanceof FsSafeError && error.code === "too-large") {
      throw new CliError({
        code: "package_too_large",
        phase: "source",
        message: `A declared package file exceeds ${maxBytes} bytes.`,
        path: normalizedPath,
      });
    }
    if (error instanceof FsSafeError) {
      throw new CliError({
        code: "unsafe_package_entry",
        phase: "source",
        message: `Could not safely read declared package file: ${error.message}`,
        path: normalizedPath,
      });
    }
    throw error;
  }
}

function packageIntegrity(files: readonly LoadedFile[]): string {
  const hash = createHash("sha256");
  const sortedFiles = files.toSorted((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  for (const file of sortedFiles) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.bytes.byteLength));
    hash.update(pathBytes);
    hash.update(Buffer.from([0]));
    hash.update(size);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function parseJsonFile(file: LoadedFile, maxBytes: number): unknown {
  if (file.bytes.byteLength > maxBytes || file.text === undefined) {
    throw new CliError({
      code: "invalid_package_json",
      phase: "package",
      message: `package.json must be UTF-8 and no larger than ${maxBytes} bytes.`,
      path: "package.json",
    });
  }
  try {
    return JSON.parse(file.text);
  } catch {
    throw new CliError({
      code: "invalid_package_json",
      phase: "package",
      message: "package.json is not valid JSON.",
      path: "package.json",
    });
  }
}

function parseJsonManifest(file: LoadedFile): unknown {
  try {
    return JSON.parse(file.text ?? "");
  } catch {
    throw new CliError({
      code: "invalid_claw_manifest",
      phase: "package",
      message: "The declared Claw manifest is not valid JSON.",
      path: file.path,
    });
  }
}

function readPackageMetadata(value: unknown): {
  name: string;
  version: string;
  manifestPath: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError({
      code: "invalid_package_metadata",
      phase: "package",
      message: "package.json must be an object.",
      path: "package.json",
    });
  }
  const record = value as Record<string, unknown>;
  const openclaw = record.openclaw;
  const manifestPath =
    openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
      ? (openclaw as Record<string, unknown>).claw
      : undefined;
  if (
    typeof record.name !== "string" ||
    !isCanonicalClawHubPackageName(record.name) ||
    typeof record.version !== "string" ||
    !isExactSemVer(record.version) ||
    typeof manifestPath !== "string" ||
    !isSafeClawRelativePath(manifestPath)
  ) {
    throw new CliError({
      code: "invalid_package_metadata",
      phase: "package",
      message:
        "package.json must declare a canonical name, exact version, and package-relative openclaw.claw path.",
      path: "package.json",
    });
  }
  return { name: record.name, version: record.version, manifestPath };
}

function parseClawMarkdown(text: string): { frontmatter: unknown; body: string } {
  const markdown = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new CliError({
      code: "missing_claw_frontmatter",
      phase: "package",
      message: "CLAW.md must start with YAML frontmatter delimited by --- lines.",
      path: "CLAW.md",
    });
  }
  const document = parseDocument(match[1] ?? "", { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new CliError(
      document.errors.map((error) => ({
        code: "invalid_claw_frontmatter",
        phase: "package" as const,
        message: error.message,
        path: "CLAW.md",
      })),
    );
  }
  let unsupportedFeature: string | undefined;
  visit(document, {
    Alias() {
      unsupportedFeature ??= "aliases";
    },
    Node(_key, node) {
      if (node.anchor) {
        unsupportedFeature ??= "anchors";
      } else if (node.tag) {
        unsupportedFeature ??= "explicit tags";
      }
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        unsupportedFeature ??= "merge keys";
      }
    },
  });
  if (unsupportedFeature) {
    throw new CliError({
      code: "unsupported_claw_yaml_feature",
      phase: "package",
      message: `CLAW.md uses unsupported YAML ${unsupportedFeature}.`,
      path: "CLAW.md",
    });
  }
  return {
    frontmatter: document.toJSON(),
    body: markdown.slice(match[0].length).trim(),
  };
}

function referencedPackagePaths(manifest: LocalClawPackage["manifest"]): string[] {
  return [
    ...Object.values(manifest.workspace.bootstrapFiles)
      .filter((entry): entry is { source: string } => entry !== undefined)
      .map((entry) => entry.source),
    ...manifest.workspace.files.map((entry) => entry.source),
    ...(manifest.metadata?.["openclaw.config"] ? [manifest.metadata["openclaw.config"]] : []),
  ];
}

export async function inspectLocalPackage(input: string): Promise<LocalClawPackage> {
  if (input.includes("://") || input.startsWith("@")) {
    throw new CliError({
      code: "unsupported_source",
      phase: "source",
      message: "The incubation CLI accepts local package directories only.",
      path: input,
    });
  }
  const requestedRoot = resolve(input);
  const root = await realpath(requestedRoot).catch(() => undefined);
  if (!root || !(await stat(root)).isDirectory()) {
    throw new CliError({
      code: "source_not_directory",
      phase: "source",
      message: "The local Claw package directory does not exist.",
      path: requestedRoot,
    });
  }
  const sourceRoot = await fsSafeRoot(root);
  const packageJson = await loadPackageFile(sourceRoot, "package.json", MAX_PACKAGE_JSON_BYTES);
  if (!packageJson) {
    throw new CliError({
      code: "missing_package_json",
      phase: "package",
      message: "The package root must contain package.json.",
      path: "package.json",
    });
  }
  const metadata = readPackageMetadata(parseJsonFile(packageJson, MAX_PACKAGE_JSON_BYTES));
  const manifestFile = await loadPackageFile(sourceRoot, metadata.manifestPath, MAX_MANIFEST_BYTES);
  if (
    !manifestFile ||
    manifestFile.text === undefined ||
    manifestFile.bytes.length > MAX_MANIFEST_BYTES
  ) {
    throw new CliError({
      code: "invalid_claw_manifest",
      phase: "package",
      message: `The declared Claw manifest must be UTF-8 and no larger than ${MAX_MANIFEST_BYTES} bytes.`,
      path: metadata.manifestPath,
    });
  }
  const markdown =
    basename(metadata.manifestPath.replaceAll("\\", "/")).toLowerCase() === "claw.md"
      ? parseClawMarkdown(manifestFile.text)
      : { frontmatter: parseJsonManifest(manifestFile), body: "" };
  const parsed = parseClawManifest(markdown.frontmatter);
  if (!parsed.ok) {
    throw new CliError(
      parsed.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        phase: "package" as const,
        message: diagnostic.message,
        path: diagnostic.path,
      })),
    );
  }
  const profilePath = parsed.manifest.metadata?.["openclaw.config"];
  if (
    profilePath !== undefined &&
    (profilePath.includes("\\") ||
      !isSafeClawRelativePath(profilePath) ||
      !/\.ya?ml$/i.test(profilePath))
  ) {
    throw new CliError({
      code: "invalid_openclaw_profile_path",
      phase: "package",
      message:
        "openclaw.config must reference a forward-slash package-relative .yml or .yaml file.",
      path: "$.metadata.openclaw.config",
    });
  }
  const declaredPaths = [
    "package.json",
    metadata.manifestPath,
    ...referencedPackagePaths(parsed.manifest),
  ];
  if (declaredPaths.length > MAX_PACKAGE_FILES) {
    throw new CliError({
      code: "too_many_package_files",
      phase: "source",
      message: `The declared package payload exceeds ${MAX_PACKAGE_FILES} files.`,
    });
  }
  const fileByPath = new Map<string, LoadedFile>();
  const declaredPathByKey = new Map<string, string>();
  const missing: string[] = [];
  let aggregateBytes = 0;
  for (const declaredPath of declaredPaths) {
    const key = portableClawPathKey(declaredPath);
    const priorPath = declaredPathByKey.get(key);
    if (priorPath !== undefined && priorPath !== declaredPath) {
      throw new CliError({
        code: "colliding_package_path",
        phase: "source",
        message: "Declared package paths must remain unique after portable case normalization.",
        path: declaredPath,
      });
    }
    declaredPathByKey.set(key, declaredPath);
    if (fileByPath.has(key)) {
      continue;
    }
    const file =
      key === "package.json"
        ? packageJson
        : key === portableClawPathKey(metadata.manifestPath)
          ? manifestFile
          : await loadPackageFile(sourceRoot, declaredPath, MAX_PACKAGE_BYTES - aggregateBytes);
    if (!file) {
      missing.push(declaredPath);
      continue;
    }
    aggregateBytes += file.bytes.byteLength;
    if (aggregateBytes > MAX_PACKAGE_BYTES) {
      throw new CliError({
        code: "package_too_large",
        phase: "source",
        message: `The declared package payload exceeds ${MAX_PACKAGE_BYTES} bytes.`,
      });
    }
    fileByPath.set(key, file);
  }
  if (missing.length > 0) {
    throw new CliError(
      missing.map((path) => ({
        code: "missing_package_file",
        phase: "package" as const,
        message: "The manifest references a file that is not present in the package.",
        path,
      })),
    );
  }
  const files = [...fileByPath.values()];
  const hasPortablePrompt = markdown.body.length > 0;
  const bootstrapFiles = Object.keys(parsed.manifest.workspace.bootstrapFiles);
  if (hasPortablePrompt && !bootstrapFiles.includes("SOUL.md")) {
    bootstrapFiles.push("SOUL.md");
  }
  const sortedBootstrapFiles = bootstrapFiles.toSorted((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return {
    source: {
      kind: "local-package",
      path: root,
      packageName: metadata.name,
      packageVersion: metadata.version,
      integrity: packageIntegrity(files),
      byteLength: aggregateBytes,
      fileCount: files.length,
    },
    manifest: parsed.manifest,
    manifestPath: metadata.manifestPath,
    payload: files.map((file) => ({ path: file.path, bytes: file.bytes })),
    summary: {
      agent: parsed.manifest.agent,
      bootstrapFiles: sortedBootstrapFiles,
      workspaceFileCount: parsed.manifest.workspace.files.length,
      skillCount: parsed.manifest.packages.filter((entry) => entry.kind === "skill").length,
      pluginCount: parsed.manifest.packages.filter((entry) => entry.kind === "plugin").length,
      mcpServerCount: Object.keys(parsed.manifest.mcpServers).length,
      cronJobCount: parsed.manifest.cronJobs.length,
      hasPortablePrompt,
      ...(parsed.manifest.metadata?.["openclaw.config"]
        ? { openClawProfilePath: parsed.manifest.metadata["openclaw.config"] }
        : {}),
    },
  };
}
