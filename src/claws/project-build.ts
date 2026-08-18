import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants as zlibConstants } from "node:zlib";
import * as tar from "tar";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  CLAW_PROJECT_RESULT_SCHEMA_VERSION,
  ClawProjectError,
  validateClawProject,
} from "./project.js";
import { readClawManifestFile } from "./reader.js";
import { isSafeClawRelativePath } from "./schema-portability.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";

export const CLAW_BUILD_RESULT_SCHEMA_VERSION = "openclaw.clawBuild.v1" as const;

type ClawBuildResult = {
  schemaVersion: typeof CLAW_BUILD_RESULT_SCHEMA_VERSION;
  projectSchemaVersion: typeof CLAW_PROJECT_RESULT_SCHEMA_VERSION;
  artifact: string;
  integrity: string;
  byteLength: number;
  files: string[];
  excludedPaths: string[];
  claw: { name: string; version: string };
};

async function writeStagedFile(stagingRoot: string, path: string, content: Buffer | string) {
  const target = resolve(stagingRoot, path);
  const targetRelative = relative(stagingRoot, target);
  if (
    !isSafeClawRelativePath(path) ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new ClawProjectError(
      "unsafe_build_path",
      `Cannot package unsafe path ${JSON.stringify(path)}.`,
    );
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await writeFile(target, content, { flag: "wx", mode: 0o644 });
  await chmod(target, 0o644);
}

async function readSelectedProjectFile(projectRoot: string, path: string): Promise<Buffer> {
  const sourceRoot = await fsSafeRoot(projectRoot);
  const read = await sourceRoot.read(path, {
    hardlinks: "reject",
    maxBytes: MAX_MANAGED_FILE_BYTES,
    nonBlockingRead: true,
    symlinks: path === "CLAW.md" ? "follow-within-root" : "reject",
  });
  return read.buffer;
}

function assertValidatedBytes(
  path: string,
  bytes: Buffer,
  expected: { byteLength: number; digest: string },
): void {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== expected.byteLength || digest !== expected.digest) {
    throw new ClawProjectError(
      "project_changed_during_build",
      `Claw project input ${JSON.stringify(path)} changed after validation; retry the build from a stable snapshot.`,
    );
  }
}

export async function extractBuiltClawArtifact(artifact: string): Promise<{
  temporaryDirectory: string;
  packageRoot: string;
  dispose: () => Promise<void>;
}> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "openclaw-claw-artifact-"));
  try {
    await tar.x({ cwd: temporaryDirectory, file: resolve(artifact), strict: true });
    const packageRoot = join(temporaryDirectory, "package");
    const packageStat = await lstat(packageRoot);
    if (!packageStat.isDirectory()) {
      throw new Error("artifact does not contain a package directory");
    }
    return {
      temporaryDirectory,
      packageRoot,
      dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw new ClawProjectError(
      "artifact_verification_failed",
      `Could not extract built Claw artifact: ${(error as Error).message}`,
    );
  }
}

export async function buildClawProject(
  projectPath: string,
  outputPath: string,
): Promise<ClawBuildResult> {
  const project = await validateClawProject(projectPath);
  if (!project.ok) {
    throw new ClawProjectError(
      "project_invalid",
      project.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
    );
  }

  const artifact = resolve(outputPath);
  if (!artifact.toLowerCase().endsWith(".tgz")) {
    throw new ClawProjectError("invalid_artifact_path", "Claw build output must end in .tgz.");
  }
  if (await lstat(artifact).catch(() => undefined)) {
    throw new ClawProjectError(
      "artifact_exists",
      `Refusing to overwrite existing artifact ${JSON.stringify(artifact)}.`,
    );
  }
  const outputParent = await stat(dirname(artifact)).catch(() => undefined);
  if (!outputParent?.isDirectory()) {
    throw new ClawProjectError(
      "artifact_parent_missing",
      `Artifact parent directory ${JSON.stringify(dirname(artifact))} does not exist.`,
    );
  }

  const temporaryDirectory = await mkdtemp(join(dirname(artifact), ".openclaw-claw-build-"));
  const stagingRoot = join(temporaryDirectory, "staging");
  const temporaryArtifact = join(temporaryDirectory, "claw.tgz");
  try {
    await mkdir(stagingRoot, { mode: 0o755 });
    const files = new Map<string, Buffer | string>();
    files.set("package.json", `${JSON.stringify(project.packageJson, null, 2)}\n`);
    const clawMarkdown = await readSelectedProjectFile(project.root, "CLAW.md");
    assertValidatedBytes("CLAW.md", clawMarkdown, project.claw.snapshot.manifest);
    files.set("CLAW.md", clawMarkdown);
    if (project.claw.packageBootstrap) {
      const bootstrap = await readSelectedProjectFile(project.root, "BOOTSTRAP.md");
      assertValidatedBytes("BOOTSTRAP.md", bootstrap, project.claw.packageBootstrap);
      files.set("BOOTSTRAP.md", bootstrap);
    }
    if (project.claw.openClawProfile) {
      const profileSnapshot = project.claw.snapshot.openClawProfile;
      if (!profileSnapshot) {
        throw new ClawProjectError(
          "project_invalid",
          "Validated OpenClaw profile is missing its source snapshot.",
        );
      }
      const profile = await readSelectedProjectFile(project.root, profileSnapshot.sourcePath);
      assertValidatedBytes(profileSnapshot.sourcePath, profile, profileSnapshot);
      files.set(profileSnapshot.sourcePath, profile);
    }
    for (const source of project.claw.snapshot.workspaceSources) {
      const bytes = await readSelectedProjectFile(project.root, source.sourcePath);
      assertValidatedBytes(source.sourcePath, bytes, source);
      files.set(source.sourcePath, bytes);
    }

    const fileNames = [...files.keys()].toSorted((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    for (const fileName of fileNames) {
      await writeStagedFile(stagingRoot, fileName, files.get(fileName) as Buffer | string);
    }
    const tarInputNames = fileNames.map((fileName) =>
      fileName.startsWith("@") ? `./${fileName}` : fileName,
    );

    await tar.c(
      {
        cwd: stagingRoot,
        file: temporaryArtifact,
        // Stabilize supported zlib output without disabling normal match compression.
        gzip: { level: 9, portable: true, strategy: zlibConstants.Z_FILTERED },
        mtime: new Date(0),
        portable: true,
        prefix: "package",
      },
      tarInputNames,
    );

    const archiveEntries: Array<{ path: string; type: string }> = [];
    await tar.t({
      file: temporaryArtifact,
      onentry: (entry) => archiveEntries.push({ path: entry.path, type: entry.type }),
    });
    const expectedEntries = fileNames.map((path) => ({ path: `package/${path}`, type: "File" }));
    if (JSON.stringify(archiveEntries) !== JSON.stringify(expectedEntries)) {
      throw new ClawProjectError(
        "artifact_contents_mismatch",
        "Built artifact contents differ from the validated project selection.",
      );
    }

    const packed = await readFile(temporaryArtifact);
    const integrity = `sha256:${createHash("sha256").update(packed).digest("hex")}`;
    const extracted = await extractBuiltClawArtifact(temporaryArtifact);
    try {
      const reread = await readClawManifestFile(extracted.packageRoot);
      if (!reread.ok) {
        throw new ClawProjectError(
          "artifact_verification_failed",
          reread.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
        );
      }
      if (
        reread.source.name !== project.packageJson.name ||
        reread.source.version !== project.packageJson.version
      ) {
        throw new ClawProjectError(
          "artifact_identity_mismatch",
          "Built artifact identity differs from the validated project.",
        );
      }
    } finally {
      await extracted.dispose();
    }

    try {
      await link(temporaryArtifact, artifact);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new ClawProjectError(
          "artifact_exists",
          `Refusing to overwrite existing artifact ${JSON.stringify(artifact)}.`,
        );
      }
      throw new ClawProjectError(
        "artifact_atomic_publish_failed",
        `Could not atomically publish artifact ${JSON.stringify(artifact)}: ${(error as Error).message}`,
      );
    }
    return {
      schemaVersion: CLAW_BUILD_RESULT_SCHEMA_VERSION,
      projectSchemaVersion: CLAW_PROJECT_RESULT_SCHEMA_VERSION,
      artifact,
      integrity,
      byteLength: packed.byteLength,
      files: fileNames,
      excludedPaths: project.excludedPaths,
      claw: { name: project.packageJson.name, version: project.packageJson.version },
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
