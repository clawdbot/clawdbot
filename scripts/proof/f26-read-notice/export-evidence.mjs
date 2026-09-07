import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureAppIdentity } from "./app-identity.mjs";
import { exportEvidenceArchive } from "./evidence-archive.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const input = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.cwd(), "apps/ios/build/F26Evidence");
const prebuild = path.join(process.cwd(), "apps/ios/build/F26Prebuild");
if (existsSync(prebuild)) {
  if (!existsSync(root)) renameSync(prebuild, root);
  else {
    const retained = path.join(root, "private/prebuild");
    assert(!existsSync(retained), "Preserve earlier prebuild evidence");
    mkdirSync(path.join(root, "private"), { recursive: true, mode: 0o700 });
    renameSync(prebuild, retained);
  }
}
const output = path.join(root, "encrypted");
assert(existsSync(path.join(root, "public")) && !existsSync(output));
const recipient = readFileSync(path.join(input, "artifact-recipient.pem"));
assert.equal(
  createHash("sha256").update(recipient).digest("hex"),
  "21b9a6b9c2b5ba1a6cf0f823571707cb5f2adbcd8fdfabc1409812e0d429e7ca",
);
const exportDeadline = Date.now() + 600000;
const preflight = JSON.parse(readFileSync(path.join(root, "public/preflight.json"), "utf8"));
assert.equal(preflight.baseline, process.env.F26_TARGET_SHA);
assert.equal(preflight.harness, process.env.GITHUB_WORKFLOW_SHA);
assert.equal(preflight.run, process.env.GITHUB_RUN_ID);
assert.equal(preflight.attempt, process.env.GITHUB_RUN_ATTEMPT);
const outcomes = {
  source: preflight.baseline,
  harness: preflight.harness,
  run: preflight.run,
  attempt: preflight.attempt,
  projectGeneration: process.env.F26_PROJECT_GENERATION_OUTCOME,
  build: "not-started",
  native: process.env.F26_NATIVE_OUTCOME,
};
let productsDirectory;
try {
  const buildAdmission = JSON.parse(
    readFileSync(
      path.join(
        root,
        preflight.phase === "prebuild"
          ? "public/preflight.json"
          : "private/prebuild/public/preflight.json",
      ),
    ),
  );
  for (const key of ["baseline", "harness", "run", "attempt"])
    assert.equal(buildAdmission[key], preflight[key]);
  const launchPath = path.join(root, "public/native-build-launch.json");
  let nativeBuildLaunch;
  if (existsSync(launchPath)) {
    outcomes.build = "unverified-launch-receipt";
    nativeBuildLaunch = JSON.parse(readFileSync(launchPath));
    for (const key of ["baseline", "harness", "run", "attempt"])
      assert.equal(nativeBuildLaunch[key], preflight[key]);
    assert.equal(nativeBuildLaunch.kind, "native-build-test");
    assert.equal(nativeBuildLaunch.command, "xcodebuild");
    assert.equal(nativeBuildLaunch.args[0], "test");
    assert(Number.isSafeInteger(nativeBuildLaunch.pid) && nativeBuildLaunch.pid > 0);
    outcomes.build = "native-build-test-started";
  }
  if (
    preflight.sourceVerified &&
    buildAdmission.sourceVerified &&
    buildAdmission.state === "admitted" &&
    nativeBuildLaunch &&
    existsSync(path.join(process.cwd(), "apps/ios/OpenClaw.xcodeproj"))
  ) {
    const captureDeadline = Date.now() + 60000;
    try {
      await captureAppIdentity({
        root: process.cwd(),
        output: path.join(root, "public"),
        destination: "generic/platform=iOS Simulator",
        phase: "exit-existing",
        baseline: preflight.baseline,
        buildStepOutcome: outcomes.build,
      });
    } catch (error) {
      writeFileSync(
        path.join(root, "public/exit-app-capture-failure.json"),
        JSON.stringify(
          {
            error: String(error),
            note: "Admission/proof failure remains primary; available partial identity is retained. No build or sign operation ran.",
          },
          null,
          2,
        ) + "\n",
      );
    }
    // Archive the existing Products tree directly into encryption. No rebuild or plaintext copy.
    const product = JSON.parse(
      readFileSync(path.join(root, "public/exit-existing-app-product.json")),
    );
    if (product.app) {
      const directory = path.dirname(path.dirname(product.app));
      assert.equal(path.basename(directory), "Products");
      assert.equal(path.basename(path.dirname(directory)), "Build");
      assert(lstatSync(directory).isDirectory());
      productsDirectory = directory;
      const identity = {
        ...outcomes,
        directory,
        archivePath: "Products",
        appIdentity: "public/exit-existing-app-product.json",
        runtimeManifestSha256: createHash("sha256")
          .update(readFileSync(path.join(input, "RUNTIME.json")))
          .digest("hex"),
        testOverlaySha256: existsSync(path.join(root, "public/test-overlay.patch"))
          ? createHash("sha256")
              .update(readFileSync(path.join(root, "public/test-overlay.patch")))
              .digest("hex")
          : null,
        complete: false,
        files: [],
        signatures: [],
      };
      const signal = AbortSignal.timeout(Math.max(1, captureDeadline - Date.now()));
      async function inventory(at, relative = "") {
        for (const name of readdirSync(at).sort()) {
          assert(Date.now() < captureDeadline, "One-minute existing-products identity deadline");
          const absolute = path.join(at, name);
          const item = path.join(relative, name);
          const stat = lstatSync(absolute);
          const entry = { path: item, mode: stat.mode & 0o7777 };
          if (stat.isSymbolicLink())
            identity.files.push({ ...entry, link: readlinkSync(absolute) });
          else if (stat.isDirectory()) {
            identity.files.push({ ...entry, directory: true });
            if (name.endsWith(".app") || name.endsWith(".xctest")) {
              for (const args of [
                ["--display", "--verbose=4", absolute],
                ["--verify", "--strict", absolute],
              ]) {
                assert(
                  Date.now() < captureDeadline,
                  "One-minute existing-products identity deadline",
                );
                const result = spawnSync("codesign", args, {
                  encoding: "utf8",
                  timeout: Math.min(10000, captureDeadline - Date.now()),
                  maxBuffer: 16 * 1024 * 1024,
                });
                identity.signatures.push({
                  path: item,
                  command: ["codesign", ...args],
                  status: result.status,
                  signal: result.signal,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  error: result.error?.message,
                });
              }
            }
            await inventory(absolute, item);
          } else {
            assert(stat.isFile(), "Unexpected build product type");
            const hash = createHash("sha256");
            let bytes = 0;
            for await (const chunk of createReadStream(absolute, { signal })) {
              hash.update(chunk);
              bytes += chunk.length;
            }
            identity.files.push({ ...entry, bytes, sha256: hash.digest("hex") });
          }
        }
      }
      try {
        await inventory(directory);
        identity.complete = true;
      } catch (error) {
        identity.error = String(error);
      } finally {
        writeFileSync(
          path.join(root, "public/build-products.json"),
          JSON.stringify(identity, null, 2) + "\n",
        );
      }
    }
  }
} catch (error) {
  writeFileSync(
    path.join(root, "public/products-retention-failure.json"),
    JSON.stringify(
      {
        error: String(error),
        note: "Available admission and proof evidence still exports; no build or signature repair ran.",
      },
      null,
      2,
    ) + "\n",
  );
}
writeFileSync(
  path.join(root, "public/workflow-outcomes.json"),
  JSON.stringify(outcomes, null, 2) + "\n",
);
await exportEvidenceArchive({
  root,
  recipient,
  preflight,
  exportDeadline,
  productsDirectory,
  identity: {
    source: process.env.F26_TARGET_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    harness: process.env.GITHUB_WORKFLOW_SHA,
  },
});
