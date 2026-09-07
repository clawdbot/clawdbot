import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const baseline = "c78e6aea330f58982252c15348341d34645a0ed5";
const dispatch = "f26-read-notice-baseline-v1";
const input = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const output = path.join(root, "apps/ios/build/F26Evidence");
const publicOutput = path.join(output, "public");
const privateOutput = path.join(output, "private");
const seconds = 60 * 60;
const deadline = Date.now() + seconds * 1000;
const gib = 1024 ** 3;
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.F26_DISPATCH_ID, dispatch);
assert.equal(process.env.F26_TARGET_SHA, baseline);
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline);
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }), "");
assert(!existsSync(output), "Preserve prior output; no overwrite or unchanged retry");
const manifest = JSON.parse(readFileSync(path.join(input, "RUNTIME.json"), "utf8"));
assert.equal(manifest.baselineMain, baseline);
assert.deepEqual(manifest.files.map((file) => file.path).sort(), [
  "artifact-recipient.pem",
  "export-evidence.mjs",
  "fixture.mjs",
  "relay-core.mjs",
  "relay-core.test.mjs",
  "run-hosted.mjs",
  "ui-case.swift",
  "unit-cases.swift",
]);
for (const file of manifest.files) {
  const bytes = readFileSync(path.join(input, file.path));
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
}
const processes = new Set();
const processGroups = new Set();
const token = randomBytes(32).toString("hex");
const controlToken = randomBytes(32).toString("hex");
let simulator;
let stopping = false;
let stopResult;
let monitorFailure;
let monitor;
let originFree;
function clean(text) {
  return text
    .replaceAll(token, "[REDACTED]")
    .replaceAll(controlToken, "[REDACTED]")
    .replaceAll(privateOutput, "<private-proof>");
}
function read(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
function measure() {
  const memory = Number(read("sysctl", ["-n", "hw.memsize"]));
  const pages = read("vm_stat", []);
  const pageSize = Number(pages.match(/page size of (\d+) bytes/)[1]);
  const freePages = Number(pages.match(/Pages free:\s+(\d+)/)[1]);
  const inactivePages = Number(pages.match(/Pages inactive:\s+(\d+)/)[1]);
  const freeMemory = (freePages + inactivePages) * pageSize;
  const rss = read("ps", ["-axo", "uid=,rss="])
    .split("\n")
    .reduce((sum, line) => {
      const [uid, value] = line.trim().split(/\s+/).map(Number);
      return sum + (uid === process.getuid() ? value * 1024 : 0);
    }, 0);
  const disk = statfsSync(root);
  const freeDisk = disk.bavail * disk.bsize;
  return { at: Date.now(), memory, freeMemory, runnerUserRSS: rss, freeDisk };
}
const admission = measure();
assert(
  admission.memory >= 6 * gib &&
    admission.freeMemory >= 2 * gib &&
    admission.runnerUserRSS < 5 * gib,
  "Measured Mac memory does not fit the bounded trial",
);
assert(admission.freeDisk >= 24 * gib, "Need 20 GiB normal writes and 4 GiB exit/export reserve");
originFree = admission.freeDisk;
mkdirSync(publicOutput, { recursive: true, mode: 0o700 });
mkdirSync(privateOutput, { mode: 0o700 });
function record(event, details = {}) {
  appendFileSync(
    path.join(publicOutput, "phase.jsonl"),
    clean(JSON.stringify({ at: Date.now(), event, ...details })) + "\n",
  );
}
record("admitted-measurement", admission);
const environment = {
  ...process.env,
  OPENCLAW_STATE_DIR: path.join(privateOutput, "state"),
  OPENCLAW_CONFIG_PATH: path.join(privateOutput, "state/openclaw.json"),
  F26_CONTROL_TOKEN: controlToken,
  F26_DEADLINE: String(deadline),
  GIT_COMMIT: baseline,
};
function start(name, command, args, env = environment) {
  assert(Date.now() < deadline && !monitorFailure && !stopping);
  const log = path.join(publicOutput, name + ".log");
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(child);
  if (child.pid) processGroups.add(child.pid);
  record("started", { name, pid: child.pid, command, args });
  for (const stream of [child.stdout, child.stderr]) {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => appendFileSync(log, clean(line) + "\n"));
  }
  child.result = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      processes.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      processes.delete(child);
      record("exited", { name, code, signal });
      resolve({ code, signal });
    });
  });
  return child;
}
async function run(name, command, args, env = environment) {
  const result = await start(name, command, args, env).result;
  assert.equal(result.code, 0, `${name} failed; retained exact exit and output`);
  assert(!monitorFailure, monitorFailure);
}
function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function signalGroups(signal) {
  for (const pid of processGroups) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
function stop() {
  stopResult ??= joinStop();
  return stopResult;
}
async function joinStop() {
  stopping = true;
  clearInterval(monitor);
  signalGroups("SIGTERM");
  const killTimer = setTimeout(() => {
    signalGroups("SIGKILL");
  }, 10000);
  await Promise.allSettled([...processes].map((child) => child.result));
  const groupDeadline = Date.now() + 15000;
  while ([...processGroups].some(groupExists) && Date.now() < groupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  clearTimeout(killTimer);
  const remainingGroups = [...processGroups].filter(groupExists);
  if (remainingGroups.length) process.exitCode = 1;
  if (simulator) {
    try {
      read("xcrun", ["simctl", "shutdown", simulator]);
    } catch (error) {
      record("simulator-shutdown-error", { error: String(error) });
      process.exitCode = 1;
    }
  }
  record("joined-stop", { simulator, remainingGroups, monitorFailure, measurement: measure() });
}
monitor = setInterval(() => {
  try {
    const snapshot = measure();
    record("measurement", snapshot);
    assert(Date.now() < deadline, "60-minute phase deadline");
    assert(snapshot.runnerUserRSS <= 5 * gib, "5 GiB aggregate runner-user RSS ceiling");
    assert(snapshot.freeMemory >= gib, "1 GiB whole-host memory safeguard");
    assert(
      snapshot.freeDisk >= 4 * gib && originFree - snapshot.freeDisk <= 20 * gib,
      "Disk growth/reserve boundary",
    );
  } catch (error) {
    monitorFailure = String(error);
    process.exitCode = 1;
    void stop();
  }
}, 2000);
process.once("SIGTERM", () => {
  process.exitCode = 143;
  void stop();
});
process.once("SIGINT", () => {
  process.exitCode = 130;
  void stop();
});
try {
  const xcode = read("xcodebuild", ["-version"]);
  assert.match(xcode, /^Xcode 26\.6\nBuild version 17F113$/);
  const swift = read("swift", ["--version"]);
  record("identity", {
    baseline,
    harnessCommit: process.env.GITHUB_WORKFLOW_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    xcode,
    swift,
    manifestSha256: createHash("sha256")
      .update(readFileSync(path.join(input, "RUNTIME.json")))
      .digest("hex"),
  });
  const expectedPaths = [
    "apps/ios/UITests/OpenClawSnapshotUITests.swift",
    "apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift",
  ];
  for (const [index, fragment] of ["ui-case.swift", "unit-cases.swift"].entries()) {
    appendFileSync(path.join(root, expectedPaths[index]), readFileSync(path.join(input, fragment)));
  }
  assert.deepEqual(read("git", ["diff", "--name-only"]).split("\n").sort(), expectedPaths.sort());
  writeFileSync(
    path.join(publicOutput, "test-overlay.patch"),
    read("git", ["diff", "--", ...expectedPaths]) + "\n",
  );
  await run("gateway-build", process.execPath, [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/build-all.mts",
    "qaRuntime",
  ]);
  mkdirSync(path.join(privateOutput, "state"), { mode: 0o700 });
  const config = {
    gateway: {
      mode: "local",
      port: 19761,
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: path.join(privateOutput, "workspace") } },
      defaults: {
        model: { primary: "f26/alpha" },
        heartbeat: { every: "0m" },
        models: {
          "f26/alpha": { agentRuntime: { id: "openclaw" } },
          "f26/beta": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
    models: {
      providers: {
        f26: {
          api: "openai-completions",
          apiKey: "synthetic-f26-only",
          baseUrl: "http://127.0.0.1:19998/v1",
          models: [
            { id: "alpha", name: "alpha", contextWindow: 32000 },
            { id: "beta", name: "beta", contextWindow: 64000 },
          ],
        },
      },
    },
  };
  writeFileSync(environment.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
  const gatewayHome = path.join(privateOutput, "home");
  mkdirSync(gatewayHome, { mode: 0o700 });
  const gatewayEnv = {
    PATH: process.env.PATH,
    HOME: gatewayHome,
    LANG: "en_US.UTF-8",
    OPENCLAW_STATE_DIR: environment.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: environment.OPENCLAW_CONFIG_PATH,
    F26_CONTROL_TOKEN: controlToken,
    F26_DEADLINE: String(deadline),
  };
  const gateway = start(
    "gateway",
    process.execPath,
    ["openclaw.mjs", "gateway", "run"],
    gatewayEnv,
  );
  const readyDeadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < readyDeadline && !monitorFailure) {
    try {
      ready = (await fetch("http://127.0.0.1:19761/readyz", { signal: AbortSignal.timeout(1000) }))
        .ok;
    } catch (error) {
      record("gateway-starting", { error: String(error) });
    }
    if (ready) break;
    assert(gateway.exitCode === null, "Gateway exited during setup");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, "Gateway readiness deadline; no denied-auth retry");
  const fixture = start(
    "fixture",
    process.execPath,
    [path.join(input, "fixture.mjs"), root, publicOutput],
    gatewayEnv,
  );
  const fixtureDeadline = Date.now() + 30000;
  while (
    !existsSync(path.join(publicOutput, "fixture-ready.json")) &&
    Date.now() < fixtureDeadline
  ) {
    assert(fixture.exitCode === null && !monitorFailure, "Fixture exited; no unchanged retry");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(existsSync(path.join(publicOutput, "fixture-ready.json")));
  const available = JSON.parse(read("xcrun", ["simctl", "list", "devices", "available", "--json"]));
  const runtimes = Object.entries(available.devices).filter(([runtime]) =>
    runtime.includes("iOS-26"),
  );
  const selected = runtimes.flatMap(([runtime, devices]) =>
    devices
      .filter((device) => device.isAvailable && device.name.startsWith("iPhone"))
      .map((device) => ({ runtime, device })),
  )[0];
  assert(selected, "No existing iOS 26 iPhone runtime; no image download");
  const types = JSON.parse(read("xcrun", ["simctl", "list", "devicetypes", "--json"])).devicetypes;
  const deviceType = types.find((type) => type.name === selected.device.name);
  assert(deviceType, "No exact simulator device type");
  simulator = read("xcrun", [
    "simctl",
    "create",
    `F26-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    deviceType.identifier,
    selected.runtime,
  ]);
  record("owned-simulator", {
    simulator,
    runtime: selected.runtime,
    deviceType: deviceType.identifier,
  });
  const testEnv = {
    ...environment,
    TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY: "1",
    TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE: JSON.stringify({
      url: "ws://127.0.0.1:19762",
      token,
    }),
    TEST_RUNNER_OPENCLAW_F26_PROOF: "1",
    TEST_RUNNER_OPENCLAW_F26_CONTROL_URL: "http://127.0.0.1:19763",
    TEST_RUNNER_OPENCLAW_F26_CONTROL_TOKEN: controlToken,
  };
  const result = await start(
    "native-ui",
    "xcodebuild",
    [
      "test",
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClawUITests",
      "-configuration",
      "Debug",
      "-destination",
      `platform=iOS Simulator,id=${simulator}`,
      "-resultBundlePath",
      path.join(publicOutput, "F26Native.xcresult"),
      "-jobs",
      "2",
      "-parallel-testing-enabled",
      "NO",
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testF26CurrentReadNoticeAndRefreshRecovery",
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testF26LateOldSessionFailureDoesNotEnterNewChat",
    ],
    testEnv,
  ).result;
  record("native-terminal", result);
  assert(
    gateway.exitCode === null && fixture.exitCode === null,
    "Gateway/fixture stopped before native completion",
  );
  if (existsSync(path.join(publicOutput, "F26Native.xcresult"))) {
    writeFileSync(
      path.join(publicOutput, "native-summary.json"),
      read("xcrun", [
        "xcresulttool",
        "get",
        "test-results",
        "summary",
        "--path",
        path.join(publicOutput, "F26Native.xcresult"),
      ]) + "\n",
    );
  }
  const buildSettings = JSON.parse(
    read("xcodebuild", [
      "-showBuildSettings",
      "-json",
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClaw",
      "-configuration",
      "Debug",
      "-destination",
      `platform=iOS Simulator,id=${simulator}`,
    ]),
  );
  const targets = buildSettings.filter((target) => target.target === "OpenClaw");
  assert.equal(targets.length, 1);
  const settings = targets[0].buildSettings;
  const app = path.join(settings.BUILT_PRODUCTS_DIR, settings.FULL_PRODUCT_NAME);
  assert(existsSync(app), "No actual app product to bind");
  const appFiles = [];
  function inventory(directory, prefix = "") {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, item.name);
      const absolute = path.join(directory, item.name);
      if (item.isSymbolicLink()) appFiles.push({ path: relative, link: readlinkSync(absolute) });
      else if (item.isDirectory()) inventory(absolute, relative);
      else
        appFiles.push({
          path: relative,
          sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        });
    }
  }
  inventory(app);
  const bundleID = read("/usr/libexec/PlistBuddy", [
    "-c",
    "Print:CFBundleIdentifier",
    path.join(app, "Info.plist"),
  ]);
  writeFileSync(
    path.join(publicOutput, "app-product.json"),
    JSON.stringify(
      {
        baseline,
        harness: process.env.GITHUB_WORKFLOW_SHA,
        bundleID,
        platform: settings.PLATFORM_NAME,
        architecture: settings.ARCHS,
        files: appFiles,
      },
      null,
      2,
    ),
  );
  await run("app-signature", "codesign", ["--display", "--verbose=4", app]);
  await run("app-signature-verify", "codesign", ["--verify", "--strict", app]);
  await run("app-archive", "tar", [
    "-czf",
    path.join(privateOutput, "native-app.tgz"),
    "-C",
    path.dirname(app),
    path.basename(app),
  ]);
  const unit = await start("shared-unit", "swift", [
    "test",
    "--package-path",
    "apps/shared/OpenClawKit",
    "--scratch-path",
    path.join(privateOutput, "swift-tests"),
    "--jobs",
    "2",
    "--no-parallel",
    "--filter",
    "ChatViewModelTests.f26",
  ]).result;
  record("shared-unit-terminal", unit);
  process.exitCode = result.code === 0 && unit.code === 0 ? 0 : 1;
} catch (error) {
  record("phase-failure", { error: String(error) });
  process.exitCode = 1;
} finally {
  await stop();
}
