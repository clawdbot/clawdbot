import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import {
  buildQaConfidenceReportFromArtifacts,
  normalizeQaConfidenceManifest,
} from "./confidence-report.js";
import {
  createQaEvidenceBundle,
  parseQaEvidenceBundle,
  readQaEvidenceBundleFile,
  serializeQaEvidenceBundle,
} from "./evidence-bundle.js";

const REPLAY_DESCRIPTOR = ".openclaw-qa-confidence.json";
const ReplayDescriptorSchema = z
  .object({
    version: z.literal(1),
    manifest: z.string().min(1),
    strictZeroUnknowns: z.boolean(),
    strictGlobalPass: z.boolean(),
  })
  .strict();

export async function exportQaConfidenceBundle(params: {
  artifactRoot: string;
  manifest: string;
  output: string;
  strictZeroUnknowns?: boolean;
  strictGlobalPass?: boolean;
}) {
  if (params.manifest === REPLAY_DESCRIPTOR) {
    throw new Error("confidence manifest conflicts with the replay descriptor");
  }
  // Read the profile once: its captured bytes determine the complete input set.
  const bundle = await createQaEvidenceBundle({
    artifactRoot: params.artifactRoot,
    artifacts: [params.manifest],
  });
  const manifestEntry = bundle.artifacts[0];
  if (!manifestEntry || manifestEntry.status !== "captured") {
    throw new Error("confidence manifest is missing");
  }
  const manifest = normalizeQaConfidenceManifest(
    JSON.parse(Buffer.from(manifestEntry.data, "base64").toString("utf8")),
  );
  const paths = [...new Set(manifest.lanes.map((lane) => lane.artifact))];
  if (paths.includes(REPLAY_DESCRIPTOR)) {
    throw new Error("confidence artifact conflicts with the replay descriptor");
  }
  const remainingPaths = paths.filter((artifact) => artifact !== params.manifest);
  if (remainingPaths.length > 0) {
    const captured = await createQaEvidenceBundle({
      artifactRoot: params.artifactRoot,
      artifacts: remainingPaths,
    });
    bundle.artifacts.push(...captured.artifacts);
  }
  const descriptor = Buffer.from(
    JSON.stringify({
      version: 1,
      manifest: params.manifest,
      strictZeroUnknowns: params.strictZeroUnknowns === true,
      strictGlobalPass: params.strictGlobalPass === true,
    }),
  );
  bundle.artifacts.push({
    path: REPLAY_DESCRIPTOR,
    status: "captured",
    sha256: createHash("sha256").update(descriptor).digest("hex"),
    data: descriptor.toString("base64"),
  });
  const bytes = serializeQaEvidenceBundle(bundle);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Validate the combined limits before creating a user-visible export.
  parseQaEvidenceBundle(bytes, sha256);
  await fs.writeFile(params.output, bytes, { flag: "wx", mode: 0o600 });
  return { output: params.output, sha256, artifacts: bundle.artifacts.length };
}

export async function replayQaConfidenceBundle(params: {
  bundlePath: string;
  expectedSha256: string;
}) {
  const bundle = await readQaEvidenceBundleFile(params.bundlePath, params.expectedSha256);
  const artifacts = new Map<string, Buffer | null>(
    bundle.artifacts.map(
      (entry) =>
        [
          entry.path,
          entry.status === "captured" ? Buffer.from(entry.data, "base64") : null,
        ] as const,
    ),
  );
  const descriptorBytes = artifacts.get(REPLAY_DESCRIPTOR);
  if (!descriptorBytes) {
    throw new Error("confidence bundle has no replay descriptor");
  }
  const descriptor = ReplayDescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8")));
  const manifestBytes = artifacts.get(descriptor.manifest);
  if (!manifestBytes || descriptor.manifest === REPLAY_DESCRIPTOR) {
    throw new Error("confidence bundle has no captured manifest");
  }
  const manifest = normalizeQaConfidenceManifest(JSON.parse(manifestBytes.toString("utf8")));
  const expectedPaths = new Set([
    REPLAY_DESCRIPTOR,
    descriptor.manifest,
    ...manifest.lanes.map((lane) => lane.artifact),
  ]);
  if (
    manifest.lanes.some((lane) => lane.artifact === REPLAY_DESCRIPTOR) ||
    expectedPaths.size !== artifacts.size ||
    [...expectedPaths].some((artifact) => !artifacts.has(artifact))
  ) {
    throw new Error("confidence bundle does not contain exactly the declared inputs");
  }
  return {
    integrity: { algorithm: "sha256", digest: params.expectedSha256, scope: "content-only" },
    report: buildQaConfidenceReportFromArtifacts({
      manifest,
      artifacts,
      generatedAt: bundle.createdAt,
      strictZeroUnknowns: descriptor.strictZeroUnknowns,
      strictGlobalPass: descriptor.strictGlobalPass,
    }),
  };
}
