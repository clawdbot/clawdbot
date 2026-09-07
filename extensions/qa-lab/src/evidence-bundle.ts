import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { z } from "zod";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 24 * 1024 * 1024;
const MAX_ARTIFACTS = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const artifactPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    if (Buffer.byteLength(value) > 1024 || /[\\<>:"|?*]/u.test(value)) {
      return false;
    }
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) {
        return false;
      }
    }
    return value
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          Buffer.byteLength(segment) <= 255 &&
          !/[. ]$/u.test(segment) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
      );
  }, "Artifact path must be a portable relative file path");

const bundleSchema = z.strictObject({
  kind: z.literal("openclaw.qa.evidence-bundle"),
  version: z.literal(1),
  createdAt: z.string().refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }, "createdAt must be a canonical ISO datetime"),
  artifacts: z
    .array(
      z.discriminatedUnion("status", [
        z.strictObject({
          path: artifactPathSchema,
          status: z.literal("captured"),
          sha256: z.string().regex(SHA256_PATTERN),
          data: z.string().max(4 * Math.ceil(MAX_ARTIFACT_BYTES / 3)),
        }),
        z.strictObject({ path: artifactPathSchema, status: z.literal("missing") }),
      ]),
    )
    .max(MAX_ARTIFACTS),
});

export type QaEvidenceBundle = z.infer<typeof bundleSchema>;

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateArtifactPaths(artifacts: readonly string[]): string[] {
  const paths = z.array(artifactPathSchema).max(MAX_ARTIFACTS).parse(artifacts);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Evidence bundle contains duplicate artifact paths");
  }
  return paths.toSorted();
}

function validateBundle(value: unknown): QaEvidenceBundle {
  const bundle = bundleSchema.parse(value);
  validateArtifactPaths(bundle.artifacts.map((artifact) => artifact.path));
  let totalBytes = 0;
  for (const artifact of bundle.artifacts) {
    if (artifact.status === "missing") {
      continue;
    }
    const bytes = Buffer.from(artifact.data, "base64");
    if (bytes.toString("base64") !== artifact.data) {
      throw new Error("Evidence artifact data must be canonical base64");
    }
    totalBytes += bytes.length;
    if (bytes.length > MAX_ARTIFACT_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Evidence artifact byte limit exceeded");
    }
    if (digestBytes(bytes) !== artifact.sha256) {
      throw new Error(`Evidence artifact digest mismatch: ${artifact.path}`);
    }
  }
  return bundle;
}

async function artifactExists(rootDir: string, relativePath: string): Promise<boolean> {
  let current = rootDir;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Evidence artifact paths must not contain symlinks");
    }
    const expectedType = index === segments.length - 1 ? stat.isFile() : stat.isDirectory();
    if (!expectedType) {
      throw new Error("Evidence artifact must be a regular file with directory ancestors");
    }
  }
  return true;
}

/** Capture named files only. Files are separate reads, not an atomic directory snapshot. */
export async function createQaEvidenceBundle(params: {
  artifactRoot: string;
  artifacts: readonly string[];
}): Promise<QaEvidenceBundle> {
  const paths = validateArtifactPaths(params.artifacts);
  const canonicalRoot = await fs.realpath(params.artifactRoot);
  const boundary = await root(canonicalRoot);
  const artifacts: QaEvidenceBundle["artifacts"] = [];
  let totalBytes = 0;
  for (const artifactPath of paths) {
    if (!(await artifactExists(canonicalRoot, artifactPath))) {
      artifacts.push({ path: artifactPath, status: "missing" });
      continue;
    }
    // Recheck containment and descriptor identity at the read boundary. The SDK's
    // best-effort guard does not isolate this process from a hostile same-UID peer.
    const { buffer } = await boundary.read(artifactPath, {
      symlinks: "reject",
      hardlinks: "reject",
      maxBytes: Math.min(MAX_ARTIFACT_BYTES, MAX_TOTAL_BYTES - totalBytes),
    });
    totalBytes += buffer.length;
    artifacts.push({
      path: artifactPath,
      status: "captured",
      sha256: digestBytes(buffer),
      data: buffer.toString("base64"),
    });
  }
  return {
    kind: "openclaw.qa.evidence-bundle",
    version: 1,
    createdAt: new Date().toISOString(),
    artifacts,
  };
}

/** Verify the caller-supplied digest before parsing; it proves integrity, not producer identity. */
export function parseQaEvidenceBundle(bytes: Buffer, expectedDigest: string): QaEvidenceBundle {
  if (bytes.length > MAX_BUNDLE_BYTES) {
    throw new Error("Evidence bundle byte limit exceeded");
  }
  if (!SHA256_PATTERN.test(expectedDigest) || digestBytes(bytes) !== expectedDigest) {
    throw new Error("Evidence bundle digest mismatch");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return validateBundle(JSON.parse(text) as unknown);
}

export async function readQaEvidenceBundleFile(
  filePath: string,
  expectedDigest: string,
): Promise<QaEvidenceBundle> {
  const boundary = await root(path.dirname(path.resolve(filePath)));
  const { buffer } = await boundary.read(path.basename(filePath), {
    symlinks: "reject",
    hardlinks: "reject",
    maxBytes: MAX_BUNDLE_BYTES,
  });
  return parseQaEvidenceBundle(buffer, expectedDigest);
}

export function serializeQaEvidenceBundle(bundle: QaEvidenceBundle): Buffer {
  const validated = validateBundle(bundle);
  validated.artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
}
