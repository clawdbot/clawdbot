// Local package and development-manifest reader for Claws.
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertNoSymlinkParents } from "../infra/fs-safe-advanced.js";
import { FsSafeError, root as fsSafeRoot, type OpenResult } from "../infra/fs-safe.js";
import { isCanonicalClawHubPackageName, isExactSemVer } from "./schema-portability.js";
import { parseClawManifest } from "./schema.js";
import { MAX_MANAGED_FILE_BYTES, MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
import type {
  ClawDiagnostic,
  ClawManifest,
  ClawReadResult,
  ClawSourceIdentity,
  ClawWorkspaceSourceSnapshot,
} from "./types.js";

type PackageJson = {
  name: string;
  version: string;
  openclaw: { claw: string };
};

type ResolvedClawSource = Omit<ClawSourceIdentity, "integrity" | "integrityKind" | "byteLength"> & {
  packageJsonRaw?: Buffer;
};

const MAX_CLAW_MANIFEST_BYTES = 1024 * 1024;
const MAX_CLAW_PACKAGE_JSON_BYTES = 256 * 1024;

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const fileRoot = await fsSafeRoot(dirname(path));
  const read = await fileRoot.read(basename(path), {
    hardlinks: "allow",
    maxBytes,
    nonBlockingRead: true,
    symlinks: "reject",
  });
  return read.buffer;
}

function fileDiagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, phase: "parse", path, message };
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function updateSnapshotHash(
  hash: ReturnType<typeof createHash>,
  label: string,
  bytes: Buffer,
): void {
  hash.update(`${Buffer.byteLength(label, "utf8")}:${label}:${bytes.byteLength}:`, "utf8");
  hash.update(bytes);
}

function workspaceSourceDiagnostic(error: unknown, sourcePath: string): ClawDiagnostic {
  if (error instanceof FsSafeError && error.code === "too-large") {
    return fileDiagnostic(
      "workspace_source_too_large",
      `Workspace source ${JSON.stringify(sourcePath)} exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`,
      "$.workspace",
    );
  }
  if (
    (error instanceof FsSafeError &&
      (error.code === "symlink" || error.code === "hardlink" || error.code === "path-mismatch")) ||
    (error instanceof Error && error.message.includes("symlinked directory"))
  ) {
    return fileDiagnostic(
      "workspace_source_unsafe",
      `Workspace source ${JSON.stringify(sourcePath)} must be a regular, non-symlinked, non-hardlinked file.`,
      "$.workspace",
    );
  }
  return fileDiagnostic(
    "workspace_source_invalid",
    `Workspace source ${JSON.stringify(sourcePath)} must resolve inside the Claw source.`,
    "$.workspace",
  );
}

async function buildDevelopmentSnapshot(params: {
  source: ResolvedClawSource;
  manifest: ClawManifest;
  manifestRaw: Buffer;
}): Promise<
  | {
      ok: true;
      integrity: string;
      byteLength: number;
      workspaceSources: ClawWorkspaceSourceSnapshot[];
    }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const hash = createHash("sha256");
  let byteLength = 0;
  const add = (label: string, bytes: Buffer) => {
    updateSnapshotHash(hash, label, bytes);
    byteLength += bytes.byteLength;
  };
  add("canonical-source", Buffer.from(params.source.manifestPath, "utf8"));
  add("manifest", params.manifestRaw);

  if (params.source.kind === "package") {
    const packageJson = params.source.packageJsonRaw;
    if (!packageJson) {
      return {
        ok: false,
        diagnostics: [fileDiagnostic("package_read_failed", "Could not snapshot package.json.")],
      };
    }
    add("package.json", packageJson);
  }

  const declaredSources = [
    ...Object.values(params.manifest.workspace.bootstrapFiles)
      .filter((entry): entry is { source: string } => entry !== undefined)
      .map((entry) => entry.source),
    ...params.manifest.workspace.files.map((entry) => entry.source),
  ].toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  const sourceRoot = await fsSafeRoot(params.source.packageRoot);
  const openedSources: Array<{ sourcePath: string; opened: OpenResult }> = [];
  const workspaceSources: ClawWorkspaceSourceSnapshot[] = [];
  try {
    let workspaceByteLength = 0;
    for (const sourcePath of declaredSources) {
      try {
        await assertNoSymlinkParents({
          rootDir: params.source.packageRoot,
          targetPath: resolve(params.source.packageRoot, sourcePath),
          allowMissing: false,
          messagePrefix: "Workspace source",
        });
        const opened = await sourceRoot.open(sourcePath, {
          hardlinks: "reject",
          symlinks: "reject",
        });
        if (opened.stat.size > MAX_MANAGED_FILE_BYTES) {
          await opened[Symbol.asyncDispose]();
          throw new FsSafeError(
            "too-large",
            `file exceeds limit of ${MAX_MANAGED_FILE_BYTES} bytes (got ${opened.stat.size})`,
          );
        }
        workspaceByteLength += opened.stat.size;
        openedSources.push({ sourcePath, opened });
      } catch (error) {
        return { ok: false, diagnostics: [workspaceSourceDiagnostic(error, sourcePath)] };
      }
    }

    if (workspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
      return {
        ok: false,
        diagnostics: [
          fileDiagnostic(
            "workspace_sources_too_large",
            `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
            "$.workspace",
          ),
        ],
      };
    }

    let readWorkspaceByteLength = 0;
    for (const { sourcePath, opened } of openedSources) {
      const bytes = await opened.handle.readFile();
      if (bytes.byteLength > MAX_MANAGED_FILE_BYTES) {
        return {
          ok: false,
          diagnostics: [
            workspaceSourceDiagnostic(
              new FsSafeError("too-large", "workspace source grew while reading"),
              sourcePath,
            ),
          ],
        };
      }
      readWorkspaceByteLength += bytes.byteLength;
      if (readWorkspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
        return {
          ok: false,
          diagnostics: [
            fileDiagnostic(
              "workspace_sources_too_large",
              `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
              "$.workspace",
            ),
          ],
        };
      }
      const normalizedSourcePath = sourcePath.replaceAll("\\", "/");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      add(`workspace:${sourcePath.replaceAll("\\", "/")}`, bytes);
      workspaceSources.push({
        sourcePath: normalizedSourcePath,
        realPath: opened.realPath,
        byteLength: bytes.byteLength,
        digest,
      });
    }
  } finally {
    await Promise.all(openedSources.map(({ opened }) => opened[Symbol.asyncDispose]()));
  }

  return { ok: true, integrity: `sha256:${hash.digest("hex")}`, byteLength, workspaceSources };
}

function parsePackageJson(value: unknown): PackageJson | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const openclaw = record.openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const claw = (openclaw as Record<string, unknown>).claw;
  if (
    typeof record.name !== "string" ||
    !isCanonicalClawHubPackageName(record.name) ||
    typeof record.version !== "string" ||
    !isExactSemVer(record.version) ||
    typeof claw !== "string" ||
    claw.trim() === ""
  ) {
    return undefined;
  }
  return { name: record.name, version: record.version, openclaw: { claw } };
}

async function readJson(
  path: string,
  code: string,
  maxBytes: number,
): Promise<
  { ok: true; raw: Buffer; value: unknown } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  let raw: Buffer;
  try {
    raw = await readBoundedFile(path, maxBytes);
  } catch (error) {
    const tooLarge =
      error instanceof RangeError || (error instanceof FsSafeError && error.code === "too-large");
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          tooLarge ? `${code}_too_large` : code,
          tooLarge
            ? `${path} exceeds ${maxBytes} bytes.`
            : `Could not read ${path}: ${(error as Error).message}`,
        ),
      ],
    };
  }
  try {
    return { ok: true, raw, value: JSON.parse(raw.toString("utf8")) };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("invalid_json", `Could not parse ${path}: ${(error as Error).message}`),
      ],
    };
  }
}

async function resolvePackageSource(
  packageRoot: string,
): Promise<
  { ok: true; source: ResolvedClawSource } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const packageRootReal = await realpath(packageRoot).catch(() => undefined);
  if (!packageRootReal) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("package_read_failed", `Could not resolve ${packageRoot}.`)],
    };
  }
  const packageJsonPath = resolve(packageRootReal, "package.json");
  const packageJsonResult = await readJson(
    packageJsonPath,
    "package_read_failed",
    MAX_CLAW_PACKAGE_JSON_BYTES,
  );
  if (!packageJsonResult.ok) {
    return packageJsonResult;
  }
  const packageJson = parsePackageJson(packageJsonResult.value);
  if (!packageJson) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "invalid_package_metadata",
          "package.json must declare non-empty name, version, and openclaw.claw fields.",
        ),
      ],
    };
  }
  if (isAbsolute(packageJson.openclaw.claw)) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("manifest_escapes_package", "openclaw.claw must be package-relative."),
      ],
    };
  }
  const manifestPath = await realpath(resolve(packageRootReal, packageJson.openclaw.claw)).catch(
    () => undefined,
  );
  if (!manifestPath || !isContained(packageRootReal, manifestPath)) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "manifest_escapes_package",
          "The declared Claw manifest must resolve inside its package root.",
        ),
      ],
    };
  }
  return {
    ok: true,
    source: {
      kind: "package",
      name: packageJson.name,
      version: packageJson.version,
      packageRoot: packageRootReal,
      manifestPath,
      packageJsonRaw: packageJsonResult.raw,
    },
  };
}

async function resolveSource(
  path: string,
): Promise<
  { ok: true; source: ResolvedClawSource } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const inputPath = resolve(path);
  const inputStat = await stat(inputPath).catch(() => undefined);
  if (!inputStat) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("read_failed", `Could not resolve Claw source ${inputPath}.`)],
    };
  }
  if (inputStat.isDirectory()) {
    return resolvePackageSource(inputPath);
  }
  if (!inputStat.isFile()) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("unsupported_source", "Claw source must be a file or directory."),
      ],
    };
  }

  const manifestPath = await realpath(inputPath);
  const packageRoot = await realpath(dirname(manifestPath));
  return {
    ok: true,
    source: {
      kind: "development",
      name: `local:${basename(manifestPath).replace(/\.json$/i, "")}`,
      version: "0.0.0-development",
      packageRoot,
      manifestPath,
    },
  };
}

export async function readClawManifestFile(path: string): Promise<ClawReadResult> {
  const sourceResult = await resolveSource(path);
  if (!sourceResult.ok) {
    return sourceResult;
  }
  const manifestResult = await readJson(
    sourceResult.source.manifestPath,
    "read_failed",
    MAX_CLAW_MANIFEST_BYTES,
  );
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const parsed = parseClawManifest(manifestResult.value);
  if (!parsed.ok) {
    return parsed;
  }
  const snapshot = await buildDevelopmentSnapshot({
    source: sourceResult.source,
    manifest: parsed.manifest,
    manifestRaw: manifestResult.raw,
  });
  if (!snapshot.ok) {
    return snapshot;
  }
  const resolvedSource = sourceResult.source;
  const source: ClawSourceIdentity = {
    kind: resolvedSource.kind,
    name: resolvedSource.name,
    version: resolvedSource.version,
    packageRoot: resolvedSource.packageRoot,
    manifestPath: resolvedSource.manifestPath,
    integrityKind: "development-snapshot",
    integrity: snapshot.integrity,
    byteLength: snapshot.byteLength,
  };
  return {
    ok: true,
    manifest: parsed.manifest,
    source,
    snapshot: { workspaceSources: snapshot.workspaceSources },
    diagnostics: parsed.diagnostics,
  };
}
