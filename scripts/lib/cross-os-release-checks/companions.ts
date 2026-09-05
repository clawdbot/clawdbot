import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validatePrepublishPluginRegistryArtifact } from "../../prepublish-plugin-registry-artifact.mjs";
import { hasChildExited, registerActiveChildProcessTree } from "./process.ts";

type CrossOsCompanionPackage = {
  name: string;
  tarballPath: string;
};

export function resolveCrossOsPackageSet(params: {
  artifactDir: string;
  candidateVersion: string;
  manifestSha256: string;
  requiredPackages: string[];
  sourceSha: string;
}) {
  const artifactDir = resolve(params.artifactDir);
  const { manifest } = validatePrepublishPluginRegistryArtifact({
    artifactDir,
    expectedCandidateVersion: params.candidateVersion,
    expectedManifestSha256: params.manifestSha256,
    expectedSourceSha: params.sourceSha,
    requiredPackages: params.requiredPackages,
  });
  const requiredPackages = new Set(params.requiredPackages);
  const companions: CrossOsCompanionPackage[] = manifest.packages
    .filter((entry: { name: string; tarball: string }) => requiredPackages.has(entry.name))
    .map((entry: { name: string; tarball: string }) => ({
      name: entry.name,
      tarballPath: resolve(artifactDir, entry.tarball),
    }));
  return {
    companions,
    // Baseline and installer selectors still belong to the published registry.
    // The candidate root is installed by its explicit tarball path.
    packages: manifest.packages
      .filter((entry: { name: string }) => entry.name !== "openclaw")
      .map((entry: { name: string; version: string; tarball: string }) => ({
        name: entry.name,
        version: entry.version,
        tarballPath: resolve(artifactDir, entry.tarball),
      })),
  };
}

export async function startCrossOsPackageRegistry(
  packages: ReturnType<typeof resolveCrossOsPackageSet>["packages"],
  logsDir: string,
) {
  if (packages.length === 0) {
    return undefined;
  }
  const directory = mkdtempSync(join(logsDir, "package-registry-"));
  const portFile = join(directory, "port");
  const log = openSync(join(directory, "server.log"), "w");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../e2e/lib/plugins/npm-registry-server.mjs", import.meta.url)),
      portFile,
      ...packages.flatMap((entry) => [entry.name, entry.version, entry.tarballPath]),
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
        OPENCLAW_NPM_REGISTRY_PORT: "0",
        OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: "1",
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      },
      stdio: ["ignore", log, log],
      detached: process.platform !== "win32",
    },
  );
  closeSync(log);
  const lifecycle = registerActiveChildProcessTree(child);
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error;
  });
  const closed = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  const close = async () => {
    if (!hasChildExited(child)) {
      lifecycle.killChildTree("SIGTERM");
      await Promise.race([closed, delay(2_000)]);
      if (!hasChildExited(child)) {
        lifecycle.killChildTree("SIGKILL");
      }
    }
    await closed;
    lifecycle.unregister();
    rmSync(portFile, { force: true });
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure || hasChildExited(child)) {
        throw failure ?? new Error("Candidate npm registry exited before readiness.");
      }
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, "utf8"));
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          return { url: `http://127.0.0.1:${port}`, close };
        }
      }
      await delay(100);
    }
    throw new Error("Candidate npm registry did not become ready.");
  } catch (error) {
    await close();
    throw error;
  }
}
