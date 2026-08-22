import { lstat, mkdir, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { readClawManifestFile } from "./reader.js";
import { isCanonicalClawHubPackageName, portableClawPathKey } from "./schema-portability.js";
import type { ClawDiagnostic, ClawReadResult } from "./types.js";

export const CLAW_PROJECT_RESULT_SCHEMA_VERSION = "openclaw.clawProject.v1" as const;

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_PROJECT_ENTRIES = 4096;
const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

type ClawProjectPackageJson = {
  name: string;
  version: string;
  type?: string;
  openclaw: { claw: "CLAW.md" };
};

type ClawProjectValidationResult =
  | {
      ok: true;
      root: string;
      packageJson: ClawProjectPackageJson;
      claw: Extract<ClawReadResult, { ok: true }>;
      excludedPaths: string[];
      diagnostics: ClawDiagnostic[];
    }
  | { ok: false; root: string; diagnostics: ClawDiagnostic[] };

export class ClawProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawProjectError";
  }
}

function diagnostic(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "policy", path, message };
}

function defaultSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 64);
  return slug || "my-claw";
}

function displayName(agentId: string): string {
  return agentId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

async function pathState(path: string): Promise<"missing" | "empty-directory" | "occupied"> {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry) {
    return "missing";
  }
  if (!entry.isDirectory()) {
    return "occupied";
  }
  return (await readdir(path)).length === 0 ? "empty-directory" : "occupied";
}

async function isFile(path: string): Promise<boolean> {
  return lstat(path)
    .then((entry) => entry.isFile())
    .catch(() => false);
}

async function isConfinedManifestFile(root: string): Promise<boolean> {
  const manifestPath = resolve(root, "CLAW.md");
  const entry = await lstat(manifestPath).catch(() => undefined);
  if (entry?.isFile()) {
    return true;
  }
  if (!entry?.isSymbolicLink()) {
    return false;
  }
  const [rootReal, targetReal] = await Promise.all([
    realpath(root).catch(() => undefined),
    realpath(manifestPath).catch(() => undefined),
  ]);
  if (!rootReal || !targetReal) {
    return false;
  }
  const targetRelative = relative(rootReal, targetReal);
  if (
    targetRelative === "" ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative) ||
    isExcludedProjectSource(targetRelative)
  ) {
    return false;
  }
  return lstat(targetReal)
    .then((target) => target.isFile())
    .catch(() => false);
}

async function discoverClawProjectRoot(projectPath: string): Promise<string> {
  const input = resolve(projectPath);
  const inputStat = await lstat(input).catch(() => undefined);
  if (!inputStat) {
    throw new ClawProjectError(
      "project_not_found",
      `Could not resolve Claw project path ${JSON.stringify(input)}.`,
    );
  }
  let current = inputStat.isDirectory() ? input : dirname(input);
  const roots: string[] = [];
  const filesystemRoot = parse(current).root;
  while (true) {
    if (
      (await isFile(resolve(current, "package.json"))) &&
      (await isConfinedManifestFile(current))
    ) {
      roots.push(await realpath(current));
    }
    if (current === filesystemRoot) {
      break;
    }
    current = dirname(current);
  }
  if (roots.length === 0) {
    throw new ClawProjectError(
      "project_not_found",
      `No Claw project containing package.json and CLAW.md was found from ${JSON.stringify(input)}.`,
    );
  }
  if (roots.length > 1) {
    throw new ClawProjectError(
      "ambiguous_project_root",
      `Multiple Claw project roots contain ${JSON.stringify(input)}: ${roots.join(", ")}.`,
    );
  }
  return roots[0] as string;
}

function projectPathKey(value: string, caseInsensitive: boolean): string {
  const normalized = value.normalize("NFC");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isExcludedProjectSource(value: string): boolean {
  return portableClawPathKey(value)
    .split("/")
    .some((segment) => segment === ".git" || segment === "node_modules");
}

async function isCaseInsensitiveProjectRoot(root: string): Promise<boolean> {
  const [canonical, folded] = await Promise.all([
    lstat(resolve(root, "CLAW.md")).catch(() => undefined),
    lstat(resolve(root, "claw.md")).catch(() => undefined),
  ]);
  return Boolean(
    canonical && folded && canonical.dev === folded.dev && canonical.ino === folded.ino,
  );
}

async function collectExcludedPaths(root: string, selectedPaths: Set<string>): Promise<string[]> {
  const excluded: string[] = [];
  const caseInsensitive = await isCaseInsensitiveProjectRoot(root);
  const selectedPathKeys = new Set(
    [...selectedPaths].map((path) => projectPathKey(path, caseInsensitive)),
  );
  let entryCount = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(resolve(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_PROJECT_ENTRIES) {
        throw new ClawProjectError(
          "project_too_many_entries",
          `Claw projects may contain at most ${MAX_PROJECT_ENTRIES} entries outside excluded dependency and source-control trees.`,
        );
      }
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") {
          excluded.push(`${path}/`);
        } else {
          await visit(path);
        }
      } else if (!selectedPathKeys.has(projectPathKey(path, caseInsensitive))) {
        excluded.push(path);
      }
    }
  };
  await visit("");
  return excluded.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export async function createClawProject(
  projectPath: string,
  options: { name?: string; agentId?: string } = {},
): Promise<{ root: string; packageJson: ClawProjectPackageJson; filesWritten: string[] }> {
  const root = resolve(projectPath);
  const initialState = await pathState(root);
  if (initialState === "occupied") {
    throw new ClawProjectError(
      "project_target_not_empty",
      `Claw project target ${JSON.stringify(root)} must be absent or empty.`,
    );
  }

  const agentId = options.agentId ?? defaultSlug(basename(root));
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new ClawProjectError(
      "invalid_agent_id",
      `Agent id ${JSON.stringify(agentId)} must match ${AGENT_ID_PATTERN}.`,
    );
  }
  const name = options.name ?? agentId;
  if (!isCanonicalClawHubPackageName(name)) {
    throw new ClawProjectError(
      "invalid_package_name",
      `Package name ${JSON.stringify(name)} must be a canonical ClawHub package name.`,
    );
  }

  const packageJson: ClawProjectPackageJson = {
    name,
    version: "0.1.0",
    openclaw: { claw: "CLAW.md" },
  };
  const clawMarkdown = [
    "---",
    "schemaVersion: 1",
    "agent:",
    `  id: ${JSON.stringify(agentId)}`,
    `  name: ${JSON.stringify(displayName(agentId))}`,
    "---",
    `You are ${displayName(agentId)}, a purpose-built OpenClaw agent.`,
    "",
  ].join("\n");

  const packageJsonPath = resolve(root, "package.json");
  const clawMarkdownPath = resolve(root, "CLAW.md");
  const createdPaths: string[] = [];
  await mkdir(root, { recursive: true });
  try {
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    createdPaths.push(packageJsonPath);
    await writeFile(clawMarkdownPath, clawMarkdown, { encoding: "utf8", flag: "wx" });
    createdPaths.push(clawMarkdownPath);
  } catch (error) {
    await Promise.allSettled(createdPaths.map((path) => unlink(path)));
    if (initialState === "missing") {
      await rmdir(root).catch(() => undefined);
    }
    throw error;
  }
  return { root, packageJson, filesWritten: ["package.json", "CLAW.md"] };
}

export async function validateClawProject(
  projectPath: string,
): Promise<ClawProjectValidationResult> {
  let root: string;
  try {
    root = await discoverClawProjectRoot(projectPath);
  } catch (error) {
    return {
      ok: false,
      root: resolve(projectPath),
      diagnostics: [
        diagnostic(
          error instanceof ClawProjectError ? error.code : "project_discovery_failed",
          "$",
          coerceErrorMessage(error),
        ),
      ],
    };
  }
  let packageValue: unknown;
  try {
    const sourceRoot = await fsSafeRoot(root);
    const read = await sourceRoot.read("package.json", {
      hardlinks: "reject",
      maxBytes: MAX_PACKAGE_JSON_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
    packageValue = JSON.parse(read.buffer.toString("utf8"));
  } catch (error) {
    return {
      ok: false,
      root,
      diagnostics: [
        diagnostic(
          "invalid_project_package",
          "package.json",
          `Could not read a safe project package.json: ${(error as Error).message}`,
        ),
      ],
    };
  }

  const record =
    packageValue && typeof packageValue === "object" && !Array.isArray(packageValue)
      ? (packageValue as Record<string, unknown>)
      : undefined;
  const openclaw =
    record?.openclaw && typeof record.openclaw === "object" && !Array.isArray(record.openclaw)
      ? (record.openclaw as Record<string, unknown>)
      : undefined;
  const scripts = record?.scripts;
  const diagnostics: ClawDiagnostic[] = [];
  if (openclaw?.claw !== "CLAW.md") {
    diagnostics.push(
      diagnostic(
        "project_manifest_must_be_claw_markdown",
        "package.json.openclaw.claw",
        'A Claw project must set openclaw.claw to "CLAW.md".',
      ),
    );
  }
  if (
    scripts !== undefined &&
    (typeof scripts !== "object" ||
      scripts === null ||
      Array.isArray(scripts) ||
      Object.keys(scripts).length > 0)
  ) {
    diagnostics.push(
      diagnostic(
        "project_scripts_forbidden",
        "package.json.scripts",
        "Claw projects cannot declare package scripts or lifecycle hooks.",
      ),
    );
  }
  if (diagnostics.length > 0) {
    return { ok: false, root, diagnostics };
  }

  const claw = await readClawManifestFile(root);
  if (!claw.ok) {
    return { ok: false, root, diagnostics: claw.diagnostics };
  }
  const excludedSource = [
    ...(claw.snapshot.openClawProfile
      ? [
          {
            path: claw.snapshot.openClawProfile.sourcePath,
            diagnosticPath: "$.metadata.openclaw.config",
          },
        ]
      : []),
    ...claw.snapshot.workspaceSources.map((source) => ({
      path: source.sourcePath,
      diagnosticPath: "$.workspace",
    })),
  ].find((source) => isExcludedProjectSource(source.path));
  if (excludedSource) {
    return {
      ok: false,
      root,
      diagnostics: [
        diagnostic(
          "project_excluded_source",
          excludedSource.diagnosticPath,
          `Selected project source ${JSON.stringify(excludedSource.path)} cannot come from .git or node_modules.`,
        ),
      ],
    };
  }
  const reservedPackageSource = claw.snapshot.workspaceSources.find(
    (source) => source.sourcePath.normalize("NFC").toLowerCase() === "package.json",
  );
  if (reservedPackageSource) {
    return {
      ok: false,
      root,
      diagnostics: [
        diagnostic(
          "project_invalid",
          "$.workspace.files",
          `Workspace source ${JSON.stringify(reservedPackageSource.sourcePath)} collides with generated package metadata.`,
        ),
      ],
    };
  }
  const selectedPathList = [
    "package.json",
    "CLAW.md",
    ...(claw.packageBootstrap ? ["BOOTSTRAP.md"] : []),
    ...(claw.snapshot.openClawProfile ? [claw.snapshot.openClawProfile.sourcePath] : []),
    ...claw.snapshot.workspaceSources.map((source) => source.sourcePath),
  ];
  const portableSelectedPaths = new Map<string, string>();
  for (const path of selectedPathList) {
    const key = portableClawPathKey(path);
    const existing = portableSelectedPaths.get(key);
    if (existing && existing !== path) {
      return {
        ok: false,
        root,
        diagnostics: [
          diagnostic(
            "project_path_collision",
            "$",
            `Selected project paths ${JSON.stringify(existing)} and ${JSON.stringify(path)} collide on portable filesystems.`,
          ),
        ],
      };
    }
    portableSelectedPaths.set(key, path);
  }
  const selectedPaths = new Set(selectedPathList);
  let excludedPaths: string[];
  try {
    excludedPaths = await collectExcludedPaths(root, selectedPaths);
  } catch (error) {
    return {
      ok: false,
      root,
      diagnostics: [
        diagnostic(
          error instanceof ClawProjectError ? error.code : "project_enumeration_failed",
          "$",
          coerceErrorMessage(error),
        ),
      ],
    };
  }
  return {
    ok: true,
    root,
    packageJson: {
      name: claw.source.name,
      version: claw.source.version,
      ...(typeof record?.type === "string" ? { type: record.type } : {}),
      openclaw: { claw: "CLAW.md" },
    },
    claw,
    excludedPaths,
    diagnostics: claw.diagnostics,
  };
}
