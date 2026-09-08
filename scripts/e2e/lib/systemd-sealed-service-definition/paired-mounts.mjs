import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

try {
  const shouldMatch = process.argv[2] === "same";
  const current = "/proof/current";
  const release = "/proof/releases/selected";
  assert.notEqual(process.geteuid(), 0, "proof must run unprivileged");
  assert.equal((await fs.lstat(current)).isSymbolicLink(), false);
  assert.equal(await fs.realpath(current), current);
  const selectedStat = await fs.stat(release);
  const currentStat = await fs.stat(current);
  assert.equal(
    currentStat.dev === selectedStat.dev && currentStat.ino === selectedStat.ino,
    shouldMatch,
  );
  await assert.rejects(fs.writeFile(`${current}/must-not-write`, "forbidden"), { code: "EROFS" });
  await assert.rejects(fs.writeFile(`${release}/must-not-write`, "forbidden"), { code: "EROFS" });

  // Exercise the update lifecycle's root-ownership boundary from the installed package.
  let ownsRoot;
  const bundles = (await fs.readdir("/app/dist"))
    .filter((file) => /^update-command-service-.*\.m?js$/.test(file))
    .toSorted();
  for (const file of bundles) {
    const module = await import(pathToFileURL(`/app/dist/${file}`).href);
    ownsRoot = Object.values(module).find(
      (value) => typeof value === "function" && value.name === "gatewayServiceCommandUsesRoot",
    );
    if (ownsRoot) {
      break;
    }
  }
  assert.equal(typeof ownsRoot, "function", "packaged update ownership export is required");
  const result = await ownsRoot({
    root: "/proof/openclaw",
    command: {
      programArguments: [process.execPath, `${current}/dist/index.js`, "gateway"],
      managedDefinition: {
        programArguments: [process.execPath, "/proof/openclaw/dist/index.js", "gateway"],
      },
      managedOverrides: { launcher: "command" },
    },
  });
  assert.equal(result, shouldMatch);
  console.log(
    `Paired read-only bind mount proof passed: ${shouldMatch ? "matching release accepted" : "different release rejected"}.`,
  );
} catch (error) {
  console.error(error);
  console.error("[systemd-paired-mounts] FAILED (exit 1)");
  process.exitCode = 1;
}
