import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { containsConfigIncludeDirective } from "../config/io.read-helpers.js";
import { GUARDED_CONFIG_INCLUDE_WRITE_ERROR } from "../config/mutation-conflict.js";
import { resolveStateDir } from "../config/paths.js";
import type { PluginAcceptedDeclaredSurface } from "../config/types.plugins.js";
import { extractArchive, resolvePackedRootDir } from "../infra/archive.js";
import { root, type Root } from "../infra/fs-safe.js";
import { withInstallWorkspace } from "../infra/install-source-utils.js";
import { loadPluginManifest, resolvePackageExtensionEntries } from "../plugins/manifest.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SystemAgentOperation } from "./operation-types.js";
import {
  applyPersistentOperation,
  isPluginBackingDefaultInferenceRoute,
  type ExecuteOptions,
} from "./operations-execution-helpers.js";
import type { SystemAgentOperationResult } from "./operations-parse.js";

type ArtifactOperation = Extract<SystemAgentOperation, { kind: "plugin-activate-artifact" }>;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_REVIEW_CHARS = 3_000;
const MAX_PENDING_ARTIFACTS = 8;
const ARTIFACT_REVIEW_TTL_MS = 60 * 60_000;
const ARTIFACT_IMPORT_DIR = "imports/plugins";
const PENDING_ARTIFACT_DIR = `${ARTIFACT_IMPORT_DIR}/pending`;

type ArtifactReview = {
  pluginId: string;
  name: string;
  version?: string;
  nativeControlUi: boolean;
  declared: PluginAcceptedDeclaredSurface;
  reviewToken: string;
};

async function assertArtifactConfigPublicationSupported(): Promise<void> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const { parsed } = await readConfigFileSnapshot();
  if (
    isRecord(parsed) &&
    (Object.hasOwn(parsed, "$include") || containsConfigIncludeDirective(parsed.plugins))
  ) {
    throw new Error(
      `${GUARDED_CONFIG_INCLUDE_WRITE_ERROR} Install the reviewed archive with openclaw plugins install.`,
    );
  }
}

function verifyArtifactDigest(bytes: Buffer, expected: string): void {
  if (
    !/^[a-f0-9]{64}$/u.test(expected) ||
    createHash("sha256").update(bytes).digest("hex") !== expected
  ) {
    throw new Error(
      "Plugin artifact SHA256 does not match. Repack the plugin and propose its new digest.",
    );
  }
}

function artifactArchiveName(sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Plugin artifact requires a lowercase SHA256 digest.");
  }
  return `${sha256}.tgz`;
}

async function withArtifactImports<T>(
  run: (files: Root, assertOwned: () => void) => Promise<T>,
): Promise<T> {
  const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
  return await withPluginLifecycleLease({}, async (lease) => {
    const stateDir = resolveStateDir();
    lease.assertOwned();
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const files = await root(stateDir, {
      hardlinks: "reject",
      symlinks: "reject",
      mode: 0o600,
      maxBytes: MAX_ARTIFACT_BYTES,
    });
    lease.assertOwned();
    await files.mkdir(PENDING_ARTIFACT_DIR);
    return await run(files, () => lease.assertOwned());
  });
}

async function prunePendingArtifacts(
  files: Root,
  archiveName: string,
  assertOwned: () => void,
): Promise<void> {
  const pending = (await files.list(PENDING_ARTIFACT_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile && /^[a-f0-9]{64}\.tgz$/u.test(entry.name))
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const expiresBefore = Date.now() - ARTIFACT_REVIEW_TTL_MS;
  let remaining = MAX_PENDING_ARTIFACTS - 1;
  // Proposal owners can disappear across processes. Reserve one slot for this
  // review and reclaim only pending imports, never an approved install source.
  for (const entry of pending) {
    if (entry.name === archiveName) {
      continue;
    }
    if (entry.mtimeMs <= expiresBefore || entry.size > MAX_ARTIFACT_BYTES || remaining === 0) {
      assertOwned();
      await files.remove(`${PENDING_ARTIFACT_DIR}/${entry.name}`);
    } else {
      remaining -= 1;
    }
  }
}

async function readVerifiedArtifact(filePath: string, sha256: string): Promise<Buffer> {
  if (!path.isAbsolute(filePath) || !/\.(?:tgz|tar\.gz)$/u.test(filePath)) {
    throw new Error(
      "Plugin artifact path must be an absolute .tgz or .tar.gz file from openclaw plugins pack.",
    );
  }
  const source = await root(path.dirname(filePath), {
    hardlinks: "reject",
    symlinks: "reject",
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  const bytes = await source.readBytes(path.basename(filePath));
  verifyArtifactDigest(bytes, sha256);
  return bytes;
}

async function inspectArtifact(rootDir: string): Promise<ArtifactReview> {
  const artifact = await root(rootDir, {
    hardlinks: "reject",
    symlinks: "reject",
    maxBytes: 1024 * 1024,
  });
  const packageJson = await artifact.readJson("package.json");
  if (!isRecord(packageJson)) {
    throw new Error("Plugin artifact package.json must be an object.");
  }
  for (const field of ["dependencies", "optionalDependencies", "scripts"]) {
    const value = packageJson[field];
    if (value !== undefined && (!isRecord(value) || Object.keys(value).length > 0)) {
      throw new Error(
        `Plugin artifacts cannot contain ${field}. Use openclaw plugins pack to bundle the plugin first.`,
      );
    }
  }
  const peers = packageJson.peerDependencies;
  if (
    (peers !== undefined &&
      (!isRecord(peers) || Object.keys(peers).some((name) => name !== "openclaw"))) ||
    (await artifact.exists("node_modules"))
  ) {
    throw new Error(
      "Plugin artifacts must bundle dependencies and may only reference the host openclaw peer.",
    );
  }
  const extensions = resolvePackageExtensionEntries(packageJson);
  if (extensions.status !== "ok" || extensions.entries.length !== 1) {
    throw new Error("Plugin artifact must declare exactly one compiled openclaw.extensions entry.");
  }
  const entry = (extensions.entries[0] ?? "").replace(/^\.\//u, "");
  if (!/^dist\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:[cm]?js)$/u.test(entry)) {
    throw new Error("Plugin artifact entry must be compiled JavaScript under dist/.");
  }
  await artifact.readBytes(entry, { maxBytes: MAX_ARTIFACT_BYTES });
  const loaded = withPluginCache(createPluginCache(), () =>
    loadPluginManifest(rootDir, true, artifact.rootReal),
  );
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const manifest = loaded.manifest;
  if (manifest.controlUi) {
    for (const asset of [manifest.controlUi.entry, ...(manifest.controlUi.styles ?? [])]) {
      await artifact.readBytes(asset, { maxBytes: MAX_ARTIFACT_BYTES });
    }
  }
  const { resolvePluginArtifactDeclaredSurface } =
    await import("../plugins/capability-artifact.js");
  const { computeDeclaredSurfaceHash } = await import("../plugins/capability-summary.js");
  const declared = resolvePluginArtifactDeclaredSurface(rootDir);
  const review: ArtifactReview = {
    pluginId: manifest.id,
    name: manifest.name ?? manifest.id,
    ...(manifest.version ? { version: manifest.version } : {}),
    nativeControlUi: Boolean(manifest.controlUi),
    declared,
    reviewToken: computeDeclaredSurfaceHash(declared),
  };
  if (JSON.stringify(review).length > MAX_REVIEW_CHARS) {
    throw new Error(
      "Plugin artifact review is too large for an agent proposal. Install it from a trusted shell after reviewing its declared capabilities.",
    );
  }
  return review;
}

async function withVerifiedArtifact<T>(
  bytes: Buffer,
  run: (artifact: { archivePath: string; review: ArtifactReview }) => Promise<T>,
): Promise<T> {
  return await withInstallWorkspace("openclaw-plugin-artifact-", async (workspace) => {
    const files = await root(workspace, { hardlinks: "reject", symlinks: "reject", mode: 0o600 });
    await files.create("package.tgz", bytes);
    await files.mkdir("extract");
    const archivePath = path.join(workspace, "package.tgz");
    const extractDir = path.join(workspace, "extract");
    await extractArchive({
      archivePath,
      destDir: extractDir,
      timeoutMs: 30_000,
      limits: {
        maxArchiveBytes: MAX_ARTIFACT_BYTES,
        maxEntries: 512,
        maxExtractedBytes: 64 * 1024 * 1024,
        maxEntryBytes: MAX_ARTIFACT_BYTES,
      },
    });
    const artifactRoot = await resolvePackedRootDir(extractDir, {
      rootMarkers: ["package.json", "openclaw.plugin.json"],
    });
    return await run({ archivePath, review: await inspectArtifact(artifactRoot) });
  });
}

/** Completes and inspects the import before the host records any executable proposal. */
export async function prepareSystemAgentPluginArtifact(
  operation: ArtifactOperation,
): Promise<ArtifactReview & { sha256: string; retainedPath: string }> {
  const bytes = await readVerifiedArtifact(operation.path, operation.sha256);
  const review = await withVerifiedArtifact(bytes, async (artifact) => artifact.review);
  await assertArtifactConfigPublicationSupported();
  if (await isPluginBackingDefaultInferenceRoute(review.pluginId)) {
    throw new Error(
      "This plugin backs OpenClaw's active inference route. Stop OpenClaw and install the artifact from a trusted shell.",
    );
  }
  return await withArtifactImports(async (files, assertOwned) => {
    const archiveName = artifactArchiveName(operation.sha256);
    const importPath = `${PENDING_ARTIFACT_DIR}/${archiveName}`;
    await prunePendingArtifacts(files, archiveName, assertOwned);
    assertOwned();
    // A fresh proposal for the same digest renews its review lifetime.
    await files.write(importPath, bytes);
    return {
      ...review,
      sha256: operation.sha256,
      retainedPath: path.join(files.rootDir, importPath),
    };
  });
}

export async function executePluginArtifactActivation(
  operation: ArtifactOperation,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  if (!opts.approved) {
    runtime.log(JSON.stringify(await prepareSystemAgentPluginArtifact(operation)));
  }
  const result = await applyPersistentOperation({
    auditOperation: "plugin.activateArtifact",
    operation,
    runtime,
    opts,
    run: async (ctx) =>
      await withArtifactImports(async (files, assertOwned) => {
        const archiveName = artifactArchiveName(operation.sha256);
        const pendingPath = `${PENDING_ARTIFACT_DIR}/${archiveName}`;
        if (
          !(await files.exists(pendingPath)) ||
          (await files.stat(pendingPath)).mtimeMs <= Date.now() - ARTIFACT_REVIEW_TTL_MS
        ) {
          throw new Error(
            "Plugin artifact review expired or is no longer retained. Propose the exact artifact again before applying it.",
          );
        }
        // Hold the lifecycle lease through installation so another proposal cannot
        // evict this review. Never fall back to the original or an approved import.
        const bytes = await files.readBytes(pendingPath);
        verifyArtifactDigest(bytes, operation.sha256);
        return await withVerifiedArtifact(bytes, async ({ archivePath, review }) => {
          const { assertConfigWriteAllowedInCurrentMode } = await import("../config/config.js");
          const { loadConfigForInstall } = await import("../cli/plugins-install-config.js");
          const { installManagedPluginSource } = await import("../plugins/management-install.js");
          assertConfigWriteAllowedInCurrentMode();
          const assertPersistentApply = () => {
            ctx.assertPersistentApply?.();
            assertOwned();
          };
          const guard = async () => {
            await assertArtifactConfigPublicationSupported();
            if (await isPluginBackingDefaultInferenceRoute(review.pluginId)) {
              throw new Error(
                "Artifact activation stopped: this plugin now backs the active inference route. Stop OpenClaw and install it from a trusted shell.",
              );
            }
            assertPersistentApply();
          };
          await assertArtifactConfigPublicationSupported();
          const snapshot = await loadConfigForInstall({
            rawSpec: archivePath,
            normalizedSpec: archivePath,
            resolvedPath: archivePath,
            installKind: "plugin",
          });
          const importPath = `${ARTIFACT_IMPORT_DIR}/${archiveName}`;
          const retainedPath = path.join(files.rootDir, importPath);
          const retained = await files.exists(importPath);
          if (retained) {
            verifyArtifactDigest(await files.readBytes(importPath), operation.sha256);
          }
          await ctx.commit(async () => {
            assertOwned();
            if (!retained) {
              await files.create(importPath, bytes);
            }
            assertOwned();
            await files.remove(pendingPath);
            try {
              const installed = await installManagedPluginSource({
                request: {
                  source: "local",
                  path: archivePath,
                  recordPath: retainedPath,
                  recordSource: "archive",
                  mode: "update",
                },
                snapshot,
                runtime,
                acknowledgeCapabilities: { reviewToken: review.reviewToken },
                beforePersistentApply: assertPersistentApply,
                beforePersistentEffect: guard,
              });
              if (!installed.ok) {
                throw new Error(installed.error);
              }
            } catch (error) {
              // The installer can throw after committing. Keep its approved source
              // and preserve the original error, including inference-loss identity.
              runtime.error(
                "Inspect the plugin's current status, then propose the exact artifact again before retrying.",
              );
              throw error;
            }
          });
          return {
            summary: `Installed approved plugin artifact ${review.pluginId}`,
            details: {
              pluginId: review.pluginId,
              sha256: operation.sha256,
              sourcePath: retainedPath,
            },
          };
        });
      }),
  });
  if (result.applied) {
    runtime.log(
      "Artifact installed. Restart the Gateway to load backend changes, then inspect the plugin's Control UI activation status.",
    );
  }
  return result;
}
