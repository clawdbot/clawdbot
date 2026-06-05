// OpenClaw SDK tests cover package behavior.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeEvalArgs } from "../../../src/test-utils/node-process.js";

type CommandResult = {
  stdout: string;
  stderr: string;
};

const COMMAND_TIMEOUT_MS = 120_000;
const tempDirs: string[] = [];
const WORKSPACE_PACKAGE_NAMES = [
  "@openclaw/gateway-protocol",
  "@openclaw/gateway-client",
  "@openclaw/sdk",
] as const;

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

type PackedPackage = {
  manifest: PackageManifest;
  tarball: string;
};

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `command timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms: ${[
            command,
            ...args,
          ].join(" ")}`,
        ),
      );
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `command failed (${String(code ?? signal)}): ${[command, ...args].join(" ")}\n` +
            `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        ),
      );
    });
  });
}

function normalizeWorkspaceDependencies(
  dependencies: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!dependencies) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies)) {
    normalized[name] =
      name.startsWith("@openclaw/") && spec === "workspace:*" ? "0.0.0-private" : spec;
  }
  return normalized;
}

async function readPackageManifest(packageRoot: string): Promise<PackageManifest> {
  const packageJson = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
  const manifest = JSON.parse(packageJson) as PackageManifest;
  return {
    ...manifest,
    dependencies: normalizeWorkspaceDependencies(manifest.dependencies),
  };
}

function tarballFileName(manifest: PackageManifest): string {
  return `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
}

async function createPackStagingRoot(
  packageRoot: string,
  destinationRoot: string,
): Promise<string> {
  const manifest = await readPackageManifest(packageRoot);
  const packageSlug = manifest.name.replace(/^@/, "").replace("/", "-");
  const stagingRoot = path.join(destinationRoot, `pack-${packageSlug}`);
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.writeFile(path.join(stagingRoot, "package.json"), JSON.stringify(manifest, null, 2));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const entry of files) {
    if (typeof entry !== "string") {
      continue;
    }
    await fs.cp(path.join(packageRoot, entry), path.join(stagingRoot, entry), {
      recursive: true,
    });
  }
  return stagingRoot;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startOpenClawRegistry(packages: PackedPackage[]): Promise<{
  registryUrl: string;
  close: () => Promise<void>;
}> {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const byTarball = new Map(packages.map((pkg) => [path.basename(pkg.tarball), pkg]));

  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const decodedPath = decodeURIComponent(url.pathname);

    if (decodedPath.startsWith("/tarballs/")) {
      const fileName = decodedPath.slice("/tarballs/".length);
      const pkg = byTarball.get(fileName);
      if (!pkg) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      createReadStream(pkg.tarball).pipe(res);
      return;
    }

    const packageName = decodedPath.slice(1);
    const pkg = byName.get(packageName);
    if (!pkg) {
      res.writeHead(404).end();
      return;
    }

    const baseUrl = `http://${host}`;
    const body = {
      name: pkg.manifest.name,
      "dist-tags": { latest: pkg.manifest.version },
      versions: {
        [pkg.manifest.version]: {
          ...pkg.manifest,
          dist: {
            tarball: `${baseUrl}/tarballs/${encodeURIComponent(path.basename(pkg.tarball))}`,
          },
        },
      },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("registry server did not bind to a TCP port");
  }
  return {
    registryUrl: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

describe("OpenClaw SDK package e2e", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("packs and imports from an external temp consumer", async () => {
    const repoRoot = process.cwd();
    const packageRoots = [
      path.join(repoRoot, "packages", "gateway-protocol"),
      path.join(repoRoot, "packages", "gateway-client"),
      path.join(repoRoot, "packages", "sdk"),
    ];
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-consumer-"));
    tempDirs.push(tempDir);

    for (const packageName of WORKSPACE_PACKAGE_NAMES) {
      await runCommand("pnpm", ["--filter", packageName, "build"], {
        cwd: repoRoot,
        timeoutMs: 180_000,
      });
    }
    for (const packageRoot of packageRoots) {
      const stagingRoot = await createPackStagingRoot(packageRoot, tempDir);
      await runCommand("npm", ["pack", "--ignore-scripts", "--pack-destination", tempDir], {
        cwd: stagingRoot,
      });
    }

    const packedPackages: PackedPackage[] = [];
    for (const packageRoot of packageRoots) {
      const manifest = await readPackageManifest(packageRoot);
      const tarball = path.join(tempDir, tarballFileName(manifest));
      await fs.stat(tarball);
      packedPackages.push({ manifest, tarball });
    }
    const sdkTarball =
      packedPackages.find((pkg) => pkg.manifest.name === "@openclaw/sdk")?.tarball ?? "";
    expect(sdkTarball).not.toBe("");
    const registry = await startOpenClawRegistry(packedPackages);

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await fs.writeFile(path.join(tempDir, ".npmrc"), `@openclaw:registry=${registry.registryUrl}`);
    try {
      await runCommand(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", sdkTarball],
        {
          cwd: tempDir,
        },
      );
    } finally {
      await registry.close();
    }

    const importScript = `
      import { GatewayClientTransport, OpenClaw, normalizeGatewayEvent } from "@openclaw/sdk";
      if (typeof GatewayClientTransport !== "function") throw new Error("missing transport export");
      if (typeof OpenClaw !== "function") throw new Error("missing client export");
      const event = normalizeGatewayEvent({
        event: "agent",
        payload: { runId: "pack-smoke", stream: "lifecycle", data: { phase: "start" } }
      });
      if (event.type !== "run.started") throw new Error("unexpected event normalization");
    `;
    await runCommand(process.execPath, createNodeEvalArgs(importScript, { evalFlag: "-e" }), {
      cwd: tempDir,
    });
  });
});
