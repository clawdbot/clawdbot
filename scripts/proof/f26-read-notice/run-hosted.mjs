import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { captureAppIdentity } from "./app-identity.mjs";
import { readCommand } from "./command-read.mjs";
import { admitProof } from "./proof-admission.mjs";

const baseline = "c78e6aea330f58982252c15348341d34645a0ed5";
const dispatch = "f26-read-notice-baseline-v3";
const input = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
assert(
  process.argv.length === 2 ||
    (process.argv.length === 3 && process.argv[2] === "--admission-only"),
);
const admissionOnly = process.argv[2] === "--admission-only";
const output = path.join(root, "apps/ios/build", admissionOnly ? "F26Prebuild" : "F26Evidence");
const publicOutput = path.join(output, "public");
const privateOutput = path.join(output, "private");
const seconds = 60 * 60;
const deadline = Date.now() + seconds * 1000;
const gib = 1024 ** 3;
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.F26_DISPATCH_ID, dispatch);
assert.equal(process.env.F26_TARGET_SHA, baseline);
assert(!existsSync(output), "Preserve prior output; no overwrite or unchanged retry");
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
let record;
function clean(text) {
  return text
    .replaceAll(token, "[REDACTED]")
    .replaceAll(controlToken, "[REDACTED]")
    .replaceAll(privateOutput, "<private-proof>");
}
function read(command, args) {
  return readCommand(command, args, record);
}
function measure(recorder = record) {
  const read = (command, args) => readCommand(command, args, recorder);
  const raw = { runnerUID: process.getuid() };
  try {
    raw.physicalMemory = read("sysctl", ["-n", "hw.memsize"]);
    raw.vmStat = read("vm_stat", []);
    raw.processes = read("ps", ["-axo", "uid=,pid=,ppid=,rss=,comm="]);
    const memory = Number(raw.physicalMemory);
    const pageSize = Number(raw.vmStat.match(/page size of (\d+) bytes/)[1]);
    const freePages = Number(raw.vmStat.match(/Pages free:\s+(\d+)/)[1]);
    const inactivePages = Number(raw.vmStat.match(/Pages inactive:\s+(\d+)/)[1]);
    const freeMemory = (freePages + inactivePages) * pageSize;
    const rss = raw.processes.split("\n").reduce((sum, line) => {
      const columns = line.trim().split(/\s+/);
      return sum + (Number(columns[0]) === process.getuid() ? Number(columns[3]) * 1024 : 0);
    }, 0);
    const disk = statfsSync(root);
    raw.fileSystem = { availableBlocks: disk.bavail, blockSize: disk.bsize };
    const freeDisk = disk.bavail * disk.bsize;
    return { at: Date.now(), memory, freeMemory, runnerUserRSS: rss, freeDisk, raw };
  } catch (error) {
    recorder("measurement-read-failed", { error: String(error), raw });
    throw error;
  }
}
const admitted = admitProof({
  root: output,
  identity: {
    baseline,
    harness: process.env.GITHUB_WORKFLOW_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    phase: admissionOnly ? "prebuild" : "runtime",
    prebuildOutcome: process.env.F26_PREBUILD_OUTCOME,
  },
  redact: clean,
  verifySource: (recorder) => {
    const read = (command, args) => readCommand(command, args, recorder);
    const actualSource = read("git", ["rev-parse", "HEAD"]);
    assert.equal(actualSource, baseline);
    assert.equal(read("git", ["status", "--porcelain"]), "");
    const manifestBytes = readFileSync(path.join(input, "RUNTIME.json"));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.baselineMain, baseline);
    assert.deepEqual(manifest.files.map((file) => file.path).sort(), [
      "app-identity.mjs",
      "artifact-recipient.pem",
      "command-read.mjs",
      "command-read.test.mjs",
      "evidence-archive.mjs",
      "evidence-archive.test.mjs",
      "export-evidence.mjs",
      "fixture.mjs",
      "proof-admission.mjs",
      "proof-admission.test.mjs",
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
    return {
      actualSource,
      runtimeManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    };
  },
  measure: (recorder) => measure(recorder),
});
const preflight = admitted.preflight;
record = admitted.record;
originFree = preflight.measurement.freeDisk;
if (admissionOnly) {
  record("prebuild-admission-complete", { productStarted: false, processGroups: [] });
  process.exit(0);
}
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
    writeFileSync(
      path.join(publicOutput, "latest-resource-observation.json"),
      JSON.stringify(snapshot, null, 2) + "\n",
    );
    const { raw: _raw, ...summary } = snapshot;
    record("measurement", summary);
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
  const app = await captureAppIdentity({
    root,
    output: publicOutput,
    destination: `platform=iOS Simulator,id=${simulator}`,
    phase: "tested",
    baseline,
    buildStepOutcome: preflight.prebuildOutcome,
  });
  await run("app-archive", "tar", [
    "-czf",
    path.join(privateOutput, "native-app.tgz"),
    "-C",
    path.dirname(app),
    path.basename(app),
  ]);
  writeFileSync(
    path.join(publicOutput, "app-archive.json"),
    JSON.stringify({
      complete: true,
      path: "private/native-app.tgz",
      sourceIdentity: "tested-app-product.json",
    }) + "\n",
  );
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
