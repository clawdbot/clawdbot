import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runManagedCommand } from "../../../../scripts/lib/managed-child-process.mts";
import { hasErrnoCode } from "../../../../src/infra/errno.js";
import { createFixtureLifetime } from "../../../helpers/fixture-lifetime.js";
import { PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { createChildEnv } from "./gateway-node-mcp.test-support.js";

// Match buildPackageArtifacts' ceiling; reserve the existing fixture cleanup window.
export const PRODUCTION_GATEWAY_ARTIFACT_TIMEOUT_MS = 45 * 60_000;

function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** Separate production artifacts from the private-QA build used by the Vitest host. */
export function createProductionGatewayArtifact(repoRoot: string) {
  const lifetime = createFixtureLifetime();
  const root = lifetime.createTempDir("openclaw-production-gateway-");
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const controller = new AbortController();
  const env = createChildEnv({
    home,
    tempDir: tmp,
    extra: {
      CI: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  let pending: Promise<{ repoRoot: string; sourceHead: string; sourceSha256: string }> | undefined;

  const run = async (bin: string, args: string[], cwd: string, capture = false) => {
    let output = "";
    const code = await runManagedCommand({
      bin,
      args,
      cwd,
      env,
      signal: controller.signal,
      requireProcessTreeExit: process.platform !== "win32",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      onReady: capture
        ? (child) => {
            child.stdout!.on("data", (chunk: Buffer) => {
              output += chunk.toString();
            });
          }
        : undefined,
    });
    if (code !== 0) {
      throw new Error(`Production artifact command failed (${code}): ${bin} ${args.join(" ")}`);
    }
    controller.signal.throwIfAborted();
    return output;
  };
  const inventory = async () => {
    const output = await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      repoRoot,
      true,
    );
    return [...new Set(output.split("\0").filter(Boolean))].toSorted();
  };
  const digestSource = async (files: string[], copy: boolean) => {
    const digest = createHash("sha256");
    for (const file of files) {
      controller.signal.throwIfAborted();
      const original = path.resolve(repoRoot, file);
      const target = path.resolve(source, file);
      if (
        !contained(repoRoot, original) ||
        !contained(source, target) ||
        file === ".git" ||
        file.startsWith(".git/")
      ) {
        throw new Error(`Invalid source snapshot path: ${file}`);
      }
      const stat = await fs.lstat(original).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (!stat) {
        digest.update(JSON.stringify([file, "deleted"]));
        continue;
      }
      const symlink = stat.isSymbolicLink();
      if (!symlink && !stat.isFile()) {
        throw new Error(`Unsupported source entry: ${file}`);
      }
      const bytes = symlink
        ? Buffer.from(await fs.readlink(original))
        : await fs.readFile(original);
      if (
        symlink &&
        (path.isAbsolute(bytes.toString()) ||
          !contained(repoRoot, path.resolve(path.dirname(original), bytes.toString())))
      ) {
        throw new Error(`Source symlink escapes checkout: ${file}`);
      }
      digest.update(
        JSON.stringify([
          file,
          symlink ? "link" : "file",
          stat.mode & 0o777,
          createHash("sha256").update(bytes).digest("hex"),
        ]),
      );
      if (copy) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (symlink) {
          await fs.symlink(bytes.toString(), target);
        } else {
          await fs.writeFile(target, bytes, { mode: stat.mode & 0o777 });
        }
      }
    }
    return digest.digest("hex");
  };
  const copyArtifacts = async (relative: string) => {
    const original = path.join(repoRoot, relative);
    const exists = await fs.lstat(original).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!exists) {
      return;
    }
    if (!exists.isDirectory()) {
      throw new Error(`Dependency artifact must be an owned directory: ${relative}`);
    }
    await fs.cp(original, path.join(source, relative), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  };
  const attestArtifacts = async (
    directory: string,
    digest: ReturnType<typeof createHash>,
  ): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      controller.signal.throwIfAborted();
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await attestArtifacts(file, digest);
      } else if (entry.isSymbolicLink()) {
        const resolved = await fs.realpath(file);
        if (!contained(source, resolved)) {
          throw new Error(`Dependency link escapes artifact: ${path.relative(source, file)}`);
        }
        digest.update(JSON.stringify([path.relative(source, file), await fs.readlink(file)]));
      } else if (entry.isFile()) {
        digest.update(
          JSON.stringify([
            path.relative(source, file),
            createHash("sha256")
              .update(await fs.readFile(file))
              .digest("hex"),
          ]),
        );
      } else {
        throw new Error(`Unsupported dependency artifact: ${path.relative(source, file)}`);
      }
    }
  };
  const prepare = async () => {
    await Promise.all([home, tmp].map((dir) => fs.mkdir(dir, { recursive: true })));
    const sourceHead = (await run("git", ["rev-parse", "HEAD"], repoRoot, true)).trim();
    await run(
      "git",
      [
        "clone",
        "--no-local",
        "--no-hardlinks",
        "--no-checkout",
        "--depth=1",
        "--",
        repoRoot,
        source,
      ],
      root,
    );
    if ((await run("git", ["rev-parse", "HEAD"], source, true)).trim() !== sourceHead) {
      throw new Error("Source HEAD changed during artifact clone");
    }
    const alternates = path.join(source, ".git", "objects", "info", "alternates");
    await fs.access(alternates).then(
      () => {
        throw new Error("Production artifact clone has shared objects");
      },
      (error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      },
    );
    await run("git", ["read-tree", "HEAD"], source);
    const files = await inventory();
    const sourceSha256 = await digestSource(files, true);
    const packageDirs = new Set(
      files
        .filter((file) => path.basename(file) === "package.json")
        .map((file) => path.dirname(file)),
    );
    const artifacts = [
      "node_modules",
      ...[...packageDirs]
        .filter((dir) => dir !== ".")
        .flatMap((dir) => [`${dir}/node_modules`, `${dir}/dist`]),
    ];
    for (const artifact of artifacts) {
      await copyArtifacts(artifact);
    }
    const dependencyDigest = createHash("sha256");
    for (const artifact of artifacts) {
      const directory = path.join(source, artifact);
      if (
        await fs.stat(directory).then(
          () => true,
          (error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return false;
            }
            throw error;
          },
        )
      ) {
        await attestArtifacts(directory, dependencyDigest);
      }
    }
    if (
      JSON.stringify(await inventory()) !== JSON.stringify(files) ||
      (await digestSource(files, false)) !== sourceSha256 ||
      (await run("git", ["rev-parse", "HEAD"], repoRoot, true)).trim() !== sourceHead
    ) {
      throw new Error("Candidate source changed during production artifact snapshot");
    }
    process.stdout.write(
      `${JSON.stringify({
        proof: "production-gateway-source",
        sourceHead,
        sourceSha256,
        dependencySha256: dependencyDigest.digest("hex"),
      })}\n`,
    );
    await run(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "--eval",
        "const { buildPackageArtifacts } = await import('./scripts/package-openclaw-for-docker.mts'); await buildPackageArtifacts(process.cwd());",
      ],
      source,
    );
    return { repoRoot: source, sourceHead, sourceSha256 };
  };
  return {
    prepare() {
      pending ??= lifetime.run(async () => {
        const timer = setTimeout(
          () => controller.abort(),
          PRODUCTION_GATEWAY_ARTIFACT_TIMEOUT_MS - PROOF_TIMEOUT_MS,
        );
        try {
          return await prepare();
        } finally {
          clearTimeout(timer);
        }
      });
      return pending;
    },
    async stop() {
      controller.abort();
      await lifetime.cleanup();
    },
  };
}
