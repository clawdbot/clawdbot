import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageManager = process.argv[2];
const version = "12.3.4";
const wrapperHash =
  "961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457";
const nativeHashes = {
  x64: "d99a8e9523e47f05f5879711f853e259ff3e17eda1653ff74ef8542b9b22807ab06900888aaf11ec21b186774ab3adc9b5c2e2d9ad50a68fb05ff128c9f8f225",
  arm64:
    "b7bd40540ecb46a88a4f2679c4c61a65cda7e437dda4c6dfa2466e8883971c138cd371029c5d2de226306810ea26056394a6143b0685fdb4506a318d038709e3",
};
const nativeHash = nativeHashes[process.arch];
const archiveRoot = "/opt/crabbox/toolchain-archives";

if (
  process.platform === "linux" &&
  nativeHash &&
  packageManager === `pnpm@${version}+sha512.${wrapperHash}`
) {
  const staging = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "pnpm-image-"));
  let corepackHome;
  try {
    const archives = [
      [`pnpm-${version}.tgz`, wrapperHash],
      [`exe.linux-${process.arch}-${version}.tgz`, nativeHash],
    ];
    let valid = true;
    for (const [name, hash] of archives) {
      const destination = join(staging, name);
      try {
        // Hash the private bytes we will extract, not a mutable image marker.
        await copyFile(join(archiveRoot, name), destination);
      } catch (error) {
        if (["ENOENT", "EACCES", "EISDIR"].includes(error.code)) {
          valid = false;
          break;
        }
        throw error;
      }
      if (
        createHash("sha512")
          .update(await readFile(destination))
          .digest("hex") !== hash
      ) {
        valid = false;
        break;
      }
    }
    if (valid) {
      corepackHome = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "openclaw-corepack-"));
      const pnpmRoot = join(corepackHome, "v1", "pnpm", version);
      const roots = [
        pnpmRoot,
        join(pnpmRoot, "node_modules", "@pnpm", `exe.linux-${process.arch}`),
      ];
      for (const [index, [name]] of archives.entries()) {
        await mkdir(roots[index], { recursive: true });
        const result = spawnSync(
          "tar",
          ["-xzf", join(staging, name), "-C", roots[index], "--strip-components=1"],
          { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
        );
        if (result.error || result.status !== 0) {
          throw new Error(`Cannot extract authenticated pnpm image archive: ${result.stderr}`, {
            cause: result.error,
          });
        }
      }
      // Corepack 0.35's v1 cache format; image-provided .corepack files are never read.
      await writeFile(
        join(pnpmRoot, ".corepack"),
        JSON.stringify({
          locator: { name: "pnpm", reference: packageManager.slice("pnpm@".length) },
          bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
          hash: `sha512.${wrapperHash}`,
        }),
      );
      process.stdout.write(`${corepackHome}\n`);
      corepackHome = undefined;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (corepackHome) {
      await rm(corepackHome, { recursive: true, force: true });
    }
  }
}
