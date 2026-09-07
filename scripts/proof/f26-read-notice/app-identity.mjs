import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Captures an existing product only. This helper never builds, signs, installs or archives it.
export async function captureAppIdentity({
  root,
  output,
  destination,
  phase,
  baseline,
  buildStepOutcome,
}) {
  const deadline = Date.now() + 60000;
  const signal = AbortSignal.timeout(60000);
  const command = (name, args) => {
    const remaining = deadline - Date.now();
    assert(remaining > 0, "One-minute existing-app identity capture deadline");
    return execFileSync(name, args, {
      cwd: root,
      encoding: "utf8",
      timeout: Math.min(10000, remaining),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
  const files = [];
  const evidence = {
    phase,
    baseline,
    harness: process.env.GITHUB_WORKFLOW_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    capturedAt: new Date().toISOString(),
    complete: false,
    files,
  };
  try {
    const settingsOutput = command("xcodebuild", [
      "-showBuildSettings",
      "-json",
      "-disableAutomaticPackageResolution",
      "-onlyUsePackageVersionsFromResolvedFile",
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClaw",
      "-configuration",
      "Debug",
      "-destination",
      destination,
    ]);
    writeFileSync(path.join(output, `${phase}-build-settings.json`), settingsOutput + "\n");
    const targets = JSON.parse(settingsOutput).filter((target) => target.target === "OpenClaw");
    assert.equal(targets.length, 1);
    const settings = targets[0].buildSettings;
    const app = path.join(settings.BUILT_PRODUCTS_DIR, settings.FULL_PRODUCT_NAME);
    assert(path.isAbsolute(app) && path.basename(app) === "OpenClaw.app" && existsSync(app));
    Object.assign(evidence, {
      app,
      platform: settings.PLATFORM_NAME,
      buildStepOutcome,
    });
    async function inventory(directory, prefix = "") {
      for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        assert(Date.now() < deadline, "One-minute existing-app identity capture deadline");
        const relative = path.join(prefix, item.name);
        const absolute = path.join(directory, item.name);
        if (item.isSymbolicLink()) files.push({ path: relative, link: readlinkSync(absolute) });
        else if (item.isDirectory()) await inventory(absolute, relative);
        else {
          const hash = createHash("sha256");
          let bytes = 0;
          for await (const chunk of createReadStream(absolute, { signal })) {
            hash.update(chunk);
            bytes += chunk.length;
          }
          files.push({ path: relative, bytes, sha256: hash.digest("hex") });
        }
      }
    }
    await inventory(app);
    evidence.bundleID = command("/usr/libexec/PlistBuddy", [
      "-c",
      "Print:CFBundleIdentifier",
      path.join(app, "Info.plist"),
    ]);
    const executable = command("/usr/libexec/PlistBuddy", [
      "-c",
      "Print:CFBundleExecutable",
      path.join(app, "Info.plist"),
    ]);
    evidence.architecture = command("lipo", ["-archs", path.join(app, executable)]);
    evidence.signatures = [];
    for (const args of [
      ["--display", "--verbose=4", app],
      ["--verify", "--strict", app],
    ]) {
      assert(Date.now() < deadline, "One-minute existing-app identity capture deadline");
      const result = spawnSync("codesign", args, {
        encoding: "utf8",
        timeout: Math.min(10000, deadline - Date.now()),
        maxBuffer: 16 * 1024 * 1024,
      });
      evidence.signatures.push({
        command: ["codesign", ...args],
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      assert.equal(result.status, 0, "Existing app signature inspection failed");
    }
    evidence.complete = true;
    return app;
  } catch (error) {
    evidence.error = String(error);
    if (error.stdout) evidence.commandStdout = String(error.stdout);
    if (error.stderr) evidence.commandStderr = String(error.stderr);
    throw error;
  } finally {
    writeFileSync(
      path.join(output, `${phase}-app-product.json`),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
}
