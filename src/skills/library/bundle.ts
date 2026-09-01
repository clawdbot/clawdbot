import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_FILES,
  type SkillLibraryFile,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { resolveStateDir } from "../../config/paths.js";
import { hasErrnoCode, isErrno } from "../../infra/errno.js";
import { ensureAbsoluteDirectory, root, walkDirectory } from "../../infra/fs-safe.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import { SkillLibraryError } from "./errors.js";

export const SKILL_LIBRARY_MAX_PATH_COMPONENTS = 16;
export const SKILL_LIBRARY_MAX_TREE_ENTRIES = SKILL_LIBRARY_MAX_FILES * 2;

type PreparedSkillBundle = {
  revision: string;
  files: Array<Static<typeof manifestSchema>[number] & { bytes: Buffer }>;
};
export type PreparedSkillLibraryBundle = PreparedSkillBundle & { description: string };
const portableCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const manifestSchema = Type.Array(
  Type.Object(
    {
      path: Type.String({ maxLength: 512 }),
      sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      sizeBytes: Type.Integer({ minimum: 0, maximum: SKILL_LIBRARY_MAX_FILE_BYTES }),
      executable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: SKILL_LIBRARY_MAX_FILES },
);

/** Published executable flags are portable metadata; host mode bits are not their authority. */
export async function readSkillLibraryManifestTree(
  directory: string,
  manifestJson: string,
  revision: string,
): Promise<SkillLibraryFile[]> {
  const manifest: unknown = JSON.parse(manifestJson);
  if (!Value.Check(manifestSchema, manifest)) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Published skill manifest is invalid.");
  }
  const safeRoot = await root(directory);
  const files: SkillLibraryFile[] = [];
  let total = 0;
  for (const file of manifest) {
    validateSkillLibraryPath(file.path);
    total += file.sizeBytes;
    if (total > SKILL_LIBRARY_MAX_BUNDLE_BYTES) {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        "Published skill manifest exceeds bundle limits.",
      );
    }
    const { buffer } = await safeRoot.read(file.path, {
      hardlinks: "reject",
      symlinks: "reject",
      maxBytes: file.sizeBytes,
    });
    if (buffer.length !== file.sizeBytes || sha256(buffer) !== file.sha256) {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        `Published skill file failed integrity verification: ${file.path}`,
      );
    }
    files.push({
      path: file.path,
      content: buffer.toString("base64"),
      encoding: "base64",
      executable: file.executable,
    });
  }
  if (prepareSkillLibraryBundle(files).revision !== revision) {
    throw new SkillLibraryError(
      "INVALID_BUNDLE",
      "Published skill revision failed integrity verification.",
    );
  }
  return files;
}

export function validateSkillLibraryPath(filePath: string): void {
  validateSkillBundlePath(filePath);
  if (
    filePath
      .split("/")
      .some((part) => [".git", "node_modules", ".openclaw"].includes(part.toLowerCase()))
  ) {
    throw new SkillLibraryError("INVALID_BUNDLE", `Non-portable skill file path: ${filePath}`);
  }
}

function validateSkillBundlePath(filePath: string): void {
  const parts = filePath.split("/");
  if (
    filePath.length > 512 ||
    Buffer.from(filePath, "utf8").toString("utf8") !== filePath ||
    parts.length > SKILL_LIBRARY_MAX_PATH_COMPONENTS ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\<>:"|?*]/u.test(part) ||
        Array.from(part).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        /[ .]$/u.test(part) ||
        part !== part.normalize("NFC") ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  ) {
    throw new SkillLibraryError("INVALID_BUNDLE", `Non-portable skill file path: ${filePath}`);
  }
}

export function decodeSkillLibraryFile(file: SkillLibraryFile): Buffer {
  const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  if (file.encoding === "base64" && bytes.toString("base64") !== file.content) {
    throw new SkillLibraryError("INVALID_BUNDLE", `Invalid base64: ${file.path}`);
  }
  return bytes;
}

/** Validate exact portable artifacts without imposing publication metadata on loaded skills. */
export function prepareSkillBundle(files: readonly SkillLibraryFile[]): PreparedSkillBundle {
  if (files.length > SKILL_LIBRARY_MAX_FILES) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Skill bundle exceeds 256 files.");
  }
  const paths = new Set<string>();
  let total = 0;
  const prepared = files
    .map((file) => {
      validateSkillBundlePath(file.path);
      const folded = file.path.toLowerCase();
      if (paths.has(folded)) {
        throw new SkillLibraryError("INVALID_BUNDLE", `Duplicate skill file: ${file.path}`);
      }
      paths.add(folded);
      const bytes = decodeSkillLibraryFile(file);
      total += bytes.length;
      if (bytes.length > SKILL_LIBRARY_MAX_FILE_BYTES || total > SKILL_LIBRARY_MAX_BUNDLE_BYTES) {
        throw new SkillLibraryError(
          "INVALID_BUNDLE",
          "Skill bundle exceeds file (1 MiB) or total (8 MiB) limit.",
        );
      }
      return {
        path: file.path,
        bytes,
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
        executable: file.executable === true,
      };
    })
    .toSorted((a, b) => portableCompare(a.path, b.path));
  for (const file of prepared) {
    const parts = file.path.toLowerCase().split("/");
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join("/"))) {
        throw new SkillLibraryError("INVALID_BUNDLE", `File/directory collision: ${file.path}`);
      }
      parts.pop();
    }
  }
  const skillMd = prepared.find((file) => file.path === "SKILL.md");
  if (!skillMd || !Buffer.from(skillMd.bytes.toString("utf8")).equals(skillMd.bytes)) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Bundle requires a UTF-8 SKILL.md.");
  }
  // Preserve the managed revision encoding: only exact artifact bytes and metadata enter the hash.
  const manifest = prepared.map(({ bytes: _bytes, ...file }) => file);
  return {
    revision: sha256(JSON.stringify(["openclaw.skill-library.tree.v1", manifest])),
    files: prepared,
  };
}

export function prepareSkillLibraryBundle(
  files: readonly SkillLibraryFile[],
): PreparedSkillLibraryBundle {
  const bundle = prepareSkillBundle(files);
  for (const file of bundle.files) {
    validateSkillLibraryPath(file.path);
  }
  const frontmatter = parseSkillFrontmatter(
    bundle.files.find((file) => file.path === "SKILL.md")!.bytes.toString("utf8"),
  );
  if (
    !frontmatter.name?.trim() ||
    !frontmatter.description?.trim() ||
    frontmatter.description.length > 1024
  ) {
    throw new SkillLibraryError(
      "INVALID_BUNDLE",
      "SKILL.md requires name and description (at most 1,024 characters).",
    );
  }
  return {
    ...bundle,
    description: frontmatter.description,
  };
}

export function skillLibraryRevisionDir(
  skillId: string,
  revision: string,
  env?: NodeJS.ProcessEnv,
): string {
  if (!/^[a-f0-9-]{36}$/u.test(skillId) || !/^[a-f0-9]{64}$/u.test(revision)) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Invalid skill revision reference.");
  }
  return path.join(resolveStateDir(env), "skill-library", skillId, "revisions", revision);
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Directory fsync is unsupported on Windows and some filesystems; other failures are real.
    if (!isErrno(error) || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code ?? "")) {
      throw error;
    }
  }
}

async function cleanAbandonedSkillStaging(parent: string): Promise<void> {
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const match = /^\.staging-([0-9]+)-[a-zA-Z0-9]+$/u.exec(entry.name);
    if (!match || !entry.isDirectory()) {
      continue;
    }
    const staging = path.join(parent, entry.name);
    const stat = await fs.lstat(staging);
    if (Date.now() - stat.mtimeMs < 3_600_000) {
      continue;
    }
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      // PID reuse and permission failures retain the artifact. Only a dead local publisher is abandoned.
      if (hasErrnoCode(error, "ESRCH")) {
        await fs.rm(staging, { recursive: true, force: true });
      }
    }
  }
}

export async function stageSkillLibraryBundle(
  skillId: string,
  bundle: PreparedSkillLibraryBundle,
  env?: NodeJS.ProcessEnv,
) {
  const destination = skillLibraryRevisionDir(skillId, bundle.revision, env);
  const parent = path.dirname(destination);
  const ensured = await ensureAbsoluteDirectory(parent, { mode: 0o700 });
  if (!ensured.ok) {
    throw ensured.error;
  }
  await cleanAbandonedSkillStaging(parent);
  const staging = await fs.mkdtemp(path.join(parent, `.staging-${process.pid}-`));
  try {
    const directories = new Set([staging]);
    for (const file of bundle.files) {
      const target = path.join(staging, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      let directory = path.dirname(target);
      while (directory !== parent) {
        directories.add(directory);
        directory = path.dirname(directory);
      }
      const handle = await fs.open(target, "wx", file.executable ? 0o500 : 0o400);
      try {
        await handle.writeFile(file.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const directory of [...directories].toSorted((a, b) => b.length - a.length)) {
      await syncDirectory(directory);
    }
    return {
      staging,
      async publish() {
        try {
          await fs.rename(staging, destination);
        } catch (error) {
          if (!isErrno(error) || !["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) {
            throw error;
          }
          // A concurrent same-content publisher may win. Never replace its immutable tree.
          await readSkillLibraryManifestTree(
            destination,
            JSON.stringify(bundle.files.map(({ bytes: _bytes, ...file }) => file)),
            bundle.revision,
          );
        }
        await syncDirectory(parent);
        await syncDirectory(path.dirname(parent));
        await syncDirectory(path.dirname(path.dirname(parent)));
        await syncDirectory(path.dirname(path.dirname(path.dirname(parent))));
        return destination;
      },
      async cleanup() {
        await fs.rm(staging, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function readSkillLibraryTree(directory: string): Promise<SkillLibraryFile[]> {
  const files = await readSkillBundleTree(directory);
  for (const file of files) {
    validateSkillLibraryPath(file.path);
  }
  return files;
}

export async function readSkillBundleTree(
  directory: string,
  includePath?: (filePath: string) => boolean,
): Promise<SkillLibraryFile[]> {
  const include = includePath ? (entry: { path: string }) => includePath(entry.path) : undefined;
  const walked = await walkDirectory(directory, {
    // Inspect one extra level: walkDirectory otherwise silently skips deeper content.
    maxDepth: SKILL_LIBRARY_MAX_PATH_COMPONENTS + 1,
    maxEntries: SKILL_LIBRARY_MAX_TREE_ENTRIES,
    symlinks: "include",
    include,
    descend: include,
  });
  if (
    walked.truncated ||
    walked.entries.some((entry) => entry.depth > SKILL_LIBRARY_MAX_PATH_COMPONENTS)
  ) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Skill tree exceeds traversal limits.");
  }
  if (walked.failedDirs.length) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Skill tree could not be read completely.");
  }
  const safeRoot = await root(directory);
  const files: SkillLibraryFile[] = [];
  let total = 0;
  for (const entry of walked.entries) {
    if (entry.kind === "directory") {
      continue;
    }
    if (entry.kind !== "file") {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        "Skill trees cannot contain links or special files.",
      );
    }
    const portablePath = entry.relativePath.split(path.sep).join("/");
    validateSkillBundlePath(portablePath);
    const { buffer, stat } = await safeRoot.read(entry.relativePath, {
      hardlinks: "reject",
      symlinks: "reject",
      maxBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
    });
    total += buffer.length;
    if (total > SKILL_LIBRARY_MAX_BUNDLE_BYTES || files.length >= SKILL_LIBRARY_MAX_FILES) {
      throw new SkillLibraryError("INVALID_BUNDLE", "Skill tree exceeds bundle limits.");
    }
    files.push({
      path: portablePath,
      content: buffer.toString("base64"),
      encoding: "base64",
      executable: (stat.mode & 0o111) !== 0,
    });
  }
  return files.toSorted((a, b) => portableCompare(a.path, b.path));
}
