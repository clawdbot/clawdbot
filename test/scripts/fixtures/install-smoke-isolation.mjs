import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const SELF = fileURLToPath(import.meta.url);
const WORKFLOW = ".github/workflows/install-smoke-reusable.yml";
const PROBE = "OPENCLAW_ISOLATION_PROBE ";
const CASES = new Set(["containment", "package-registry", "registry-only", "empty-required"]);
const LOG_LIMIT = 16 * 1024 * 1024;
const ownedConfigurations = [];

export function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function createTarball(archive, source, entries) {
  execFileSync("tar", ["-czf", archive, "-C", source, ...entries], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

export function createPayloadFixture(root, options = {}) {
  const archiveRoot = path.join(root, "candidate-root");
  const scriptsDir = path.join(archiveRoot, "scripts");
  const packageRoot = path.join(root, "package-root");
  const packageContents = path.join(packageRoot, "package");
  const packageDir = path.join(root, "package-output");
  const payloadDir = path.join(root, "payload");
  for (const dir of [scriptsDir, packageContents, packageDir, payloadDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(scriptsDir, "install-target.sh"), "#!/bin/sh\necho install\n");
  if (options.symlinkInstaller) {
    fs.symlinkSync("install-target.sh", path.join(scriptsDir, "install.sh"));
  } else {
    fs.writeFileSync(path.join(scriptsDir, "install.sh"), "#!/bin/sh\necho install\n");
  }
  fs.writeFileSync(path.join(scriptsDir, "install-cli.sh"), "#!/bin/sh\necho cli\n");
  const archivePath = path.join(root, "candidate.tar.gz");
  createTarball(archivePath, root, ["candidate-root"]);
  fs.writeFileSync(
    path.join(packageContents, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.8.1-beta.3" })}\n`,
  );
  fs.writeFileSync(path.join(packageContents, "index.js"), "console.log('openclaw');\n");
  const packagePath = path.join(packageDir, "candidate.tgz");
  createTarball(packagePath, packageRoot, ["package"]);
  if (options.symlinkPackage) {
    fs.unlinkSync(packagePath);
    fs.symlinkSync(archivePath, packagePath);
  }
  return { archiveRoot, archivePath, packageDir, packagePath, packageContents, payloadDir, root };
}

export function createHostCanaries(home) {
  const canaries = ["host-private", "host-env", "host-output"].map((filename) =>
    path.join(home, filename),
  );
  for (const file of canaries) {
    fs.writeFileSync(file, "synthetic-host-only\n", { mode: 0o666 });
    // The positive control uses the image's UID, not the host owner's UID.
    fs.chmodSync(file, 0o666);
  }
  return canaries;
}

export function workflowStep(harness, owner, name) {
  const workflow = parse(fs.readFileSync(path.join(harness, WORKFLOW), "utf8"));
  const step = workflow.jobs[owner]?.steps?.find((entry) => entry.name === name);
  assert.equal(typeof step?.run, "string", `missing workflow command: ${owner}/${name}`);
  return step;
}

export function assertLogBoundary(log) {
  const stops = [...log.matchAll(/::stop-commands::([a-f0-9]{64})(?:\r?\n)/gu)];
  assert.equal(stops.length, 1, "expected one exact stop command");
  const stop = stops[0];
  const token = stop[1];
  // The runner recognizes both command syntaxes and case-insensitive command names.
  const boundaries = [
    ...log.matchAll(/::([^:\s]+)(?: [^\r\n]*?)?::|##\[([^;\]\r\n]+)(?:;[^\]\r\n]*)?\]/gu),
  ].filter((match) => ["stop-commands", token].includes((match[1] ?? match[2]).toLowerCase()));
  assert.equal(boundaries.length, 2, "unexpected stop/resume command");
  assert.equal(boundaries[0].index, stop.index, "unexpected first command boundary");
  assert.equal(boundaries[1][0], `::${token}::`, "resume must be the exact normal command");
  const probes = [...log.matchAll(/OPENCLAW_ISOLATION_PROBE ([^\r\n]+)/gu)];
  assert.ok(probes.length > 0, "guest probe did not execute");
  for (const probe of probes) {
    assert.ok(
      probe.index > stop.index && probe.index < boundaries[1].index,
      "unframed guest output",
    );
  }
  for (const command of log.matchAll(/::warning::synthetic candidate command/gu)) {
    assert.ok(
      command.index > stop.index && command.index < boundaries[1].index,
      "unframed candidate command",
    );
  }
  return probes.map((probe) => JSON.parse(probe[1]));
}

export function assertGuestProbe(probe, accessible = false) {
  assert.ok(Number.isInteger(probe.uid) && probe.uid > 0, "guest must actually be nonroot");
  assert.deepEqual(probe.environment, [], "host command files or credentials reached the guest");
  assert.equal(probe.socket, false, "Docker socket reached the guest");
  assert.equal(probe.gitMetadata, false, "host Git metadata reached the guest");
  assert.ok(Array.isArray(probe.paths) && probe.paths.length === 3, "missing host canary attempts");
  for (const entry of probe.paths) {
    assert.equal(entry.read, accessible, "unexpected canary read access");
    assert.equal(entry.write, accessible, "unexpected canary write access");
    if (!accessible) {
      assert.ok(
        ["ENOENT", "EACCES", "EROFS"].includes(entry.readError),
        "canary read infrastructure failure",
      );
      assert.ok(
        ["ENOENT", "EACCES", "EROFS"].includes(entry.writeError),
        "canary write infrastructure failure",
      );
    }
  }
}

export function assertMounts(args, expected) {
  assert.ok(
    !args.some((arg) => ["--mount", "--volumes-from", "--privileged"].includes(arg)),
    "extra Docker authority",
  );
  const mounts = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-v" || args[index] === "--volume") {
      assert.equal(typeof args[index + 1], "string", "missing mount value");
      mounts.push(args[++index]);
    }
    if (args[index].startsWith("--volume=") || args[index].startsWith("--mount=")) {
      assert.fail("unexpected mount spelling");
    }
    if (args[index] === "-e") {
      assert.ok(args[index + 1]?.indexOf("=") > 0, "host environment inheritance");
    }
  }
  assert.deepEqual(
    mounts.toSorted((a, b) => a.localeCompare(b)),
    expected.toSorted((a, b) => a.localeCompare(b)),
    "mount tuple mismatch",
  );
  assert.ok(args.includes("--cap-drop") && args.includes("ALL"), "capabilities not dropped");
  assert.ok(args.includes("no-new-privileges"), "privilege escalation not disabled");
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: LOG_LIMIT,
    ...options,
  }).trim();
}

function readEvents(file) {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function record(config, event) {
  fs.appendFileSync(config.events, `${JSON.stringify(event)}\n`);
}

function absent(config, name) {
  assert.match(name, /^openclaw-(?:candidate-(?:build|seal)|bun-smoke)-[A-Za-z0-9-]+$/u);
  const names = run(config.docker, [
    "container",
    "ls",
    "--all",
    "--filter",
    `name=${name}`,
    "--format",
    "{{.Names}}",
  ]);
  assert.ok(!names.split("\n").includes(name), `production container remains: ${name}`);
}

function processIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    pid,
    parent: Number(fields[1]),
    group: Number(fields[2]),
    session: Number(fields[3]),
    start: fields[19],
  };
}

function sameProcess(identity) {
  try {
    assert.deepEqual(processIdentity(identity.pid), identity, "owned process identity changed");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// This function is serialized into authored fixture bytes; it never runs on the host.
async function guestProbe(paths, phase) {
  const guestFs = await import("node:fs");
  const results = paths.map((file) => {
    const result = { read: false, write: false };
    try {
      guestFs.readFileSync(file);
      result.read = true;
    } catch (error) {
      result.readError = error.code;
    }
    try {
      guestFs.appendFileSync(file, "guest-canary-write\n");
      result.write = true;
    } catch (error) {
      result.writeError = error.code;
    }
    return result;
  });
  const environment = [
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "AWS_ACCESS_KEY_ID",
  ].filter((name) => process.env[name]);
  console.log(
    "OPENCLAW_ISOLATION_PROBE " +
      JSON.stringify({
        phase,
        uid: process.getuid(),
        paths: results,
        environment,
        socket: guestFs.existsSync("/var/run/docker.sock"),
        gitMetadata: guestFs.existsSync("/harness/.git"),
      }),
  );
  console.log("::warning::synthetic candidate command");
}

function probeSource(config, phase) {
  return `await (${guestProbe.toString()})(${JSON.stringify(config.canaries)}, ${JSON.stringify(phase)});\n`;
}

async function dockerObserver(configPath, args) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const value = (flag) => args[args.indexOf(flag) + 1];
  const name = args.includes("--name") ? value("--name") : null;
  record(config, { event: "docker", args, name });
  if (args[0] === "run" && name?.startsWith("openclaw-candidate-")) {
    const mount = args.find((arg) => arg.endsWith(":/harness:ro"));
    assert.equal(typeof mount, "string");
    const scratch = path.dirname(mount.slice(0, -":/harness:ro".length));
    assert.equal(path.dirname(scratch), config.scratch);
    assert.match(path.basename(scratch), /^openclaw-candidate\.[A-Za-z0-9]+$/u);
    const worker = name.startsWith("openclaw-candidate-build-");
    const mounts = [
      `${scratch}/harness:/harness:ro`,
      `${config.archive}:/input/candidate.tar.gz:ro`,
    ];
    if (config.mode === "package") {
      mounts.push(
        ...(worker
          ? [`${scratch}/package:/output`]
          : [`${scratch}/package:/package:ro`, `${config.payload}:/payload`]),
      );
    }
    if (config.registry) {
      mounts.push(
        ...(worker
          ? [`${scratch}/registry:/registry-output`]
          : [`${scratch}/registry:/registry-input:ro`, `${config.registry}:/registry`]),
      );
    }
    assertMounts(args, mounts);
    assert.equal(value("--user"), worker ? "node" : `${process.getuid()}:${process.getgid()}`);
    if (worker) {
      const timeout = processIdentity(process.ppid);
      const command = fs.readFileSync(`/proc/${timeout.pid}/cmdline`, "utf8").split("\0");
      assert.equal(path.basename(command[0]), "timeout");
      assert.deepEqual(command.slice(1, 3), ["--kill-after=30s", "50m"]);
      record(config, { event: "worker", name, timeout });
    } else {
      assert.equal(value("--network"), "none");
      const previous = readEvents(config.events).find((entry) => entry.event === "worker");
      assert.ok(previous, "sealer started without worker");
      absent(config, previous.name);
      record(config, {
        event: "worker-absent-before-seal",
        name: previous.name,
        rootSha256: config.mode === "package" ? sha256(`${scratch}/package/candidate.tgz`) : null,
        backgroundWriter: config.synthetic
          ? fs.existsSync(`${scratch}/package/writer-ready`)
          : null,
      });
    }
  } else if (args[0] === "run" && name?.startsWith("openclaw-bun-smoke-")) {
    const harness = args.find((arg) => arg.endsWith(":/harness:ro"));
    assert.equal(typeof harness, "string");
    const source = harness.slice(0, -":/harness:ro".length);
    assert.equal(path.dirname(source), config.runnerTemp);
    assert.match(path.basename(source), /^bun-smoke-harness\.[A-Za-z0-9]+$/u);
    assertMounts(args, [
      harness,
      `${config.runnerTemp}/install-smoke-candidate-payload:/payload:ro`,
    ]);
    assert.equal(value("--user"), "node");
    assert.ok(args.includes("OPENCLAW_FS_SAFE_NATIVE_CONTRACT=required"));
    assert.ok(!fs.existsSync(`${source}/.git`));
  } else if (args[0] === "run") {
    assertMounts(args, []);
  }
  const child = spawn(config.docker, args, { stdio: "inherit" });
  let exited = false;
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  if (config.registry && name?.startsWith("openclaw-candidate-build-")) {
    try {
      const deadline = Date.now() + 60_000;
      while (true) {
        const names = run(config.docker, [
          "container",
          "ls",
          "--filter",
          `name=${name}`,
          "--format",
          "{{.Names}}",
        ]);
        if (names.split("\n").includes(name)) {
          break;
        }
        assert.ok(!exited && Date.now() < deadline, "registry worker never became ready");
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      const witness = run(config.docker, [
        "exec",
        name,
        "node",
        "--input-type=module",
        "-e",
        probeSource(config, "registry-worker"),
      ]);
      process.stderr.write(`${witness}\n`);
      record(config, { event: "registry-guest-witness" });
    } catch (error) {
      child.kill("SIGTERM");
      await completion;
      throw error;
    }
  }
  const result = await completion;
  record(config, { event: "docker-result", name, ...result });
  process.exitCode = result.code ?? 1;
}

async function launch(config, command, args, expected, signal) {
  const env = {
    PATH: `${config.bin}:${process.env.PATH}`,
    HOME: config.home,
    TMPDIR: config.scratch,
    RUNNER_TEMP: config.runnerTemp,
    CI: "1",
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
    GITHUB_ENV: config.canaries[1],
    GITHUB_OUTPUT: config.canaries[2],
    GH_TOKEN: "synthetic-host-only",
    OPENCLAW_FS_SAFE_NATIVE_CONTRACT: "required",
    OPENCLAW_DOCKER_E2E_REPO_ROOT: config.source,
    OPENCLAW_QR_SMOKE_FORCE_INSTALL: "1",
    OPENCLAW_QR_SMOKE_IMAGE: config.qrImage,
  };
  const child = spawn(command, args, {
    cwd: config.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exceeded = false;
  let alarm = false;
  /** @type {Error | undefined} */
  let captureError;
  const identity = processIdentity(child.pid);
  const terminate = () => {
    const worker = readEvents(config.events).find((event) => event.event === "worker");
    if (worker && sameProcess(worker.timeout)) {
      assert.equal(worker.timeout.session, identity.session, "timeout escaped owned session");
      assert.equal(
        worker.timeout.group,
        worker.timeout.pid,
        "unexpected GNU timeout process group",
      );
      process.kill(-worker.timeout.group, "SIGTERM");
    }
    if (sameProcess(identity)) {
      process.kill(child.pid, "SIGTERM");
    }
  };
  const capture = (bytes) => {
    if (output.length + bytes.length > LOG_LIMIT) {
      exceeded = true;
      terminate();
      return;
    }
    output += bytes.toString();
    if (signal && !alarm && !captureError && output.includes("OPENCLAW_ISOLATION_READY")) {
      try {
        const worker = readEvents(config.events).find((event) => event.event === "worker");
        assert.ok(
          worker && sameProcess(worker.timeout),
          "missing live production timeout identity",
        );
        assert.equal(worker.timeout.parent, identity.pid, "timeout is not the launcher's child");
        assert.equal(worker.timeout.session, identity.session, "timeout escaped owned session");
        alarm = true;
        if (signal === "SIGALRM") {
          process.kill(worker.timeout.pid, signal);
        } else {
          terminate();
        }
        record(config, {
          event: signal === "SIGALRM" ? "production-timeout-alarm" : "owned-cancellation",
        });
      } catch (error) {
        captureError =
          error instanceof Error ? error : new Error("signal observation failed", { cause: error });
        terminate();
      }
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let watchdog = false;
  const timer = setTimeout(
    () => {
      watchdog = true;
      terminate();
    },
    signal ? 5 * 60_000 : 65 * 60_000,
  );
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signalName) => resolve({ code, signal: signalName }));
  }).finally(() => clearTimeout(timer));
  fs.writeFileSync(path.join(config.root, "command.log"), output);
  // Observe production cleanup before any emergency removal, even on a failing assertion.
  const names = [
    ...new Set(
      readEvents(config.events)
        .map((event) => event.name)
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    absent(config, name);
  }
  record(config, { event: "production-absence", names, ...result });
  for (const canary of config.canaries) {
    assert.equal(fs.readFileSync(canary, "utf8"), "synthetic-host-only\n", "host canary changed");
  }
  if (captureError) {
    throw captureError;
  }
  assert.equal(watchdog, false, "infrastructure watchdog fired; not production timeout proof");
  assert.equal(exceeded, false, "candidate log bound exceeded");
  assert.equal(result.signal, null, "launcher did not preserve a numeric production status");
  assert.equal(result.code, expected, "unexpected production result");
  if (signal) {
    assert.equal(alarm, true, "production alarm/cancellation was not exercised");
  }
  return output;
}

function packArguments(config) {
  return [
    path.join(config.harness, "scripts/docker/pack-candidate-in-container.sh"),
    "--archive",
    config.archive,
    "--harness-dir",
    config.harness,
    "--image",
    "openclaw-install-candidate-packager:local",
    "--repository",
    "openclaw/openclaw",
    "--target-sha",
    process.env.TARGET_SHA,
    "--harness-repository",
    "openclaw/openclaw",
    "--harness-sha",
    process.env.HARNESS_SHA,
    "--run-id",
    process.env.GITHUB_RUN_ID,
    "--run-attempt",
    process.env.GITHUB_RUN_ATTEMPT,
    "--allow-unreleased-changelog",
    "true",
    "--mode",
    config.mode,
    ...(config.mode === "package" ? ["--output-dir", config.payload] : []),
    ...(config.synthetic ? ["--install-policy", "package-candidate"] : []),
    ...(config.registry
      ? [
          "--registry-output-dir",
          config.registry,
          "--candidate-version",
          process.env.PACKAGE_VERSION,
          "--required-packages-json",
          JSON.stringify(config.required),
        ]
      : []),
  ];
}

function syntheticSource(config, outcome) {
  const fixture = createPayloadFixture(path.join(config.root, "fixture"));
  const write = (name, contents) => {
    const target = path.join(fixture.archiveRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write(
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version: "2026.8.1-beta.3",
      packageManager: JSON.parse(fs.readFileSync(path.join(config.harness, "package.json"), "utf8"))
        .packageManager,
      scripts: { postinstall: "node lifecycle.mjs" },
    }),
  );
  write("CHANGELOG.md", "# Changelog\n\n## 2026.8.1-beta.3\n\n- Synthetic isolation fixture.\n");
  write(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
  );
  write("pnpm-workspace.yaml", "packages: []\n");
  write("lifecycle.mjs", probeSource(config, "pnpm-lifecycle"));
  write("candidate.tgz", fs.readFileSync(fixture.packagePath));
  write(
    "scripts/package-openclaw-for-docker.mjs",
    `
import fs from "node:fs";
import { spawn } from "node:child_process";
${probeSource(config, "candidate-pack")}
const writer = spawn(process.execPath, ["-e", "const fs=require('node:fs');fs.writeFileSync('/output/writer-ready','ready');setInterval(()=>fs.appendFileSync('/output/writer-ready','.'),20)"], { detached: true, stdio: "ignore" });
writer.unref();
const deadline = Date.now() + 10000;
while (!fs.existsSync("/output/writer-ready") || fs.readFileSync("/output/writer-ready", "utf8").length < 6) {
  if (Date.now() > deadline) throw new Error("background writer did not start");
  await new Promise(resolve => setTimeout(resolve, 20));
}
process.kill(writer.pid, 0);
console.log("OPENCLAW_ISOLATION_READY");
${outcome === "hold" ? "setInterval(() => {}, 1000);" : outcome === "failure" ? "process.exit(37);" : 'fs.copyFileSync("candidate.tgz", "/output/candidate.tgz");'}
`,
  );
  createTarball(fixture.archivePath, fixture.root, ["candidate-root"]);
  config.archive = fixture.archivePath;
  config.source = fixture.archiveRoot;
  return fixture;
}

function configuration(root, harness, name) {
  const config = {
    root: path.join(root, name),
    harness,
    mode: "package",
    registry: "",
    required: [],
    archive: path.join(process.env.RUNNER_TEMP, "candidate.tar.gz"),
    qrImage: `openclaw-qr-isolation-${randomUUID()}`,
    synthetic: false,
  };
  for (const field of ["bin", "home", "scratch", "runnerTemp"]) {
    config[field] = path.join(config.root, field);
    fs.mkdirSync(config[field], { recursive: true });
  }
  config.cwd = config.root;
  config.payload = path.join(config.root, "payload");
  config.events = path.join(config.root, "events.jsonl");
  config.canaries = createHostCanaries(config.home);
  config.docker = run("which", ["docker"]);
  fs.symlinkSync(harness, path.join(config.root, ".release-harness"));
  ownedConfigurations.push(config);
  return config;
}

function cleanupContainers(config) {
  const names = [
    ...new Set(
      readEvents(config.events)
        .map((event) => event.name)
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    assert.match(name, /^openclaw-(?:candidate-(?:build|seal)|bun-smoke)-[A-Za-z0-9-]+$/u);
    const inventory = run(config.docker, [
      "container",
      "ls",
      "--all",
      "--filter",
      `name=${name}`,
      "--format",
      "{{.Names}}",
    ]);
    if (inventory.split("\n").includes(name)) {
      record(config, { event: "emergency-cleanup", name });
      run(config.docker, ["rm", "-f", name]);
    }
    absent(config, name);
  }
}

function writeObserver(config) {
  const file = path.join(config.root, "observer.json");
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(
    path.join(config.bin, "docker"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(SELF)} docker ${quote(file)} "$@"\n`,
    { mode: 0o755 },
  );
}

async function containment(root, harness) {
  const control = configuration(root, harness, "accessible-control");
  const controlScript = path.join(control.root, "probe.mjs");
  fs.writeFileSync(controlScript, probeSource(control, "control"));
  const controlLog = run(control.docker, [
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "node",
    "--entrypoint",
    "node",
    "-v",
    `${controlScript}:/probe.mjs:ro`,
    ...control.canaries.flatMap((file) => ["-v", `${file}:${file}`]),
    "openclaw-install-candidate-packager:local",
    "/probe.mjs",
  ]);
  const controlProbe = JSON.parse(
    controlLog
      .split("\n")
      .find((line) => line.startsWith(PROBE))
      .slice(PROBE.length),
  );
  fs.writeFileSync(path.join(control.root, "control.log"), controlLog);
  assert.throws(() => assertGuestProbe(controlProbe), /canary read access/u);
  assertGuestProbe(controlProbe, true);
  record(control, { event: "red-control-rejected", reason: "unexpected canary read access" });

  for (const [name, outcome, expected, signal] of [
    ["sealing", "success", 0],
    ["failure", "failure", 37],
    ["alarm", "hold", 124, "SIGALRM"],
    ["cancellation", "hold", 143, "SIGTERM"],
  ]) {
    const config = configuration(root, harness, name);
    config.synthetic = true;
    syntheticSource(config, outcome);
    writeObserver(config);
    const output = await launch(config, "bash", packArguments(config), expected, signal);
    const probes = assertLogBoundary(output);
    for (const probe of probes) {
      assertGuestProbe(probe);
    }
    assert.ok(probes.some((probe) => probe.phase === "pnpm-lifecycle"));
    assert.ok(probes.some((probe) => probe.phase === "candidate-pack"));
    const events = readEvents(config.events);
    const sealing = events.filter((event) => event.event === "worker-absent-before-seal");
    assert.equal(sealing.length, expected === 0 ? 1 : 0);
    if (expected === 0) {
      assert.equal(sealing[0].backgroundWriter, true);
      assert.equal(sha256(`${config.payload}/candidate.tgz`), sealing[0].rootSha256);
    }
  }

  const bun = configuration(root, harness, "bun");
  const fixture = createPayloadFixture(path.join(bun.root, "fixture"));
  fs.writeFileSync(
    path.join(fixture.packageContents, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.8.1-beta.3",
      bin: { openclaw: "index.js" },
      scripts: { postinstall: "node probe.mjs" },
    }),
  );
  fs.writeFileSync(
    path.join(fixture.packageContents, "probe.mjs"),
    `${probeSource(bun, "bun-lifecycle")}process.exit(37);\n`,
  );
  fs.mkdirSync(`${bun.runnerTemp}/install-smoke-candidate-payload`);
  createTarball(
    `${bun.runnerTemp}/install-smoke-candidate-payload/candidate.tgz`,
    path.dirname(fixture.packageContents),
    ["package"],
  );
  writeObserver(bun);
  const bunLog = await launch(
    bun,
    "bash",
    [
      "-e",
      "-o",
      "pipefail",
      "-c",
      workflowStep(
        harness,
        "bun_global_install_smoke",
        "Run Bun global install candidate-payload smoke",
      ).run,
    ],
    1,
  );
  for (const probe of assertLogBoundary(bunLog)) {
    assertGuestProbe(probe);
  }
  assert.ok(bunLog.includes('"phase":"bun-lifecycle"'), "Bun lifecycle did not execute");

  const qr = configuration(root, harness, "qr");
  const source = syntheticSource(qr, "failure").archiveRoot;
  fs.mkdirSync(path.join(source, "ui"));
  fs.mkdirSync(path.join(source, "patches"));
  fs.writeFileSync(path.join(source, "ui/package.json"), '{"name":"fixture-ui","private":true}');
  fs.mkdirSync(path.join(source, "node_modules/qrcode"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "node_modules/qrcode/package.json"),
    '{"name":"qrcode","type":"module","main":"index.js"}',
  );
  fs.writeFileSync(
    path.join(source, "node_modules/qrcode/index.js"),
    `${probeSource(qr, "qr-import")}process.exit(37);`,
  );
  fs.mkdirSync(path.join(source, "scripts/e2e"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "scripts/e2e/qr-import-docker.sh"),
    "echo UNTRUSTED_HOST_LAUNCHER\nexit 99\n",
  );
  writeObserver(qr);
  const qrLog = await launch(
    qr,
    "bash",
    [
      "-e",
      "-o",
      "pipefail",
      "-c",
      workflowStep(harness, "qr_package_install_smoke", "Run QR package install smoke").run,
    ],
    37,
  );
  for (const probe of assertLogBoundary(qrLog)) {
    assertGuestProbe(probe);
  }
  assert.ok(qrLog.includes('"phase":"qr-import"'), "QR candidate import did not execute");
  assert.ok(!qrLog.includes("UNTRUSTED_HOST_LAUNCHER"));
  assert.equal(
    run(qr.docker, [
      "container",
      "ls",
      "--all",
      "--filter",
      `ancestor=${qr.qrImage}`,
      "--format",
      "{{.ID}}",
    ]),
    "",
  );
}

async function registryProof(root, harness, name) {
  const config = configuration(root, harness, name);
  config.mode = name === "package-registry" ? "package" : "registry-only";
  config.registry = path.join(config.root, "registry");
  config.required = name === "empty-required" ? [] : ["@openclaw/discord"];
  writeObserver(config);
  const log = await launch(config, "bash", packArguments(config), 0);
  for (const probe of assertLogBoundary(log)) {
    assertGuestProbe(probe);
  }
  const { validatePrepublishPluginRegistryArtifact } = await import(
    path.join(harness, "scripts/prepublish-plugin-registry-artifact.mjs")
  );
  const manifestFile = path.join(config.registry, "prepublish-plugin-registry.json");
  const result = validatePrepublishPluginRegistryArtifact({
    artifactDir: config.registry,
    expectedCandidateVersion: process.env.PACKAGE_VERSION,
    expectedSourceSha: process.env.TARGET_SHA,
    expectedManifestSha256: sha256(manifestFile),
    requiredPackages: [],
  });
  assert.deepEqual(
    result.manifest.packages.map((entry) => entry.name),
    config.required,
  );
  const barrier = readEvents(config.events).filter(
    (event) => event.event === "worker-absent-before-seal",
  );
  assert.equal(barrier.length, 1);
  if (config.mode === "package") {
    assert.equal(sha256(`${config.payload}/candidate.tgz`), barrier[0].rootSha256);
  }
  for (const entry of result.manifest.packages) {
    const before = sha256(path.join(config.registry, entry.tarball));
    run(
      config.docker,
      [
        "run",
        "--rm",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "node",
        "--entrypoint",
        "bash",
        "-v",
        `${config.registry}:/registry:ro`,
        "openclaw-install-candidate-packager:local",
        "-lc",
        `npm install --prefix /tmp/consumer --ignore-scripts ${quote(`/registry/${entry.tarball}`)} >/dev/null`,
      ],
      { timeout: 10 * 60_000 },
    );
    assert.equal(sha256(path.join(config.registry, entry.tarball)), before);
  }
}

async function main(argv) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "real isolation proof is CI-only");
  assert.equal(process.platform, "linux", "real isolation proof requires Linux");
  assert.notEqual(process.getuid(), 0, "proof must be nonroot");
  if (argv[0] === "docker") {
    try {
      await dockerObserver(argv[1], argv.slice(2));
    } catch (error) {
      record(JSON.parse(fs.readFileSync(argv[1], "utf8")), {
        event: "observer-failure",
        message: error instanceof Error ? error.message : "Docker observer failed",
      });
      throw error;
    }
    return;
  }
  const [name, harnessArgument] = argv;
  assert.ok(CASES.has(name), "unknown fixed isolation case");
  const harness = fs.realpathSync(harnessArgument);
  assert.match(process.env.HARNESS_SHA ?? "", /^[a-f0-9]{40}$/u);
  assert.match(process.env.TARGET_SHA ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(run("git", ["-C", harness, "rev-parse", "HEAD"]), process.env.HARNESS_SHA);
  assert.equal(
    process.env.HARNESS_SHA,
    process.env.GITHUB_WORKFLOW_SHA,
    "standalone caller identity differs",
  );
  assert.match(
    process.env.GITHUB_WORKFLOW_REF ?? "",
    /^openclaw\/openclaw\/\.github\/workflows\/install-smoke\.yml@refs\/heads\/.+$/u,
  );
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/u);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/u);
  const root = path.join(process.env.RUNNER_TEMP, "install-smoke-isolation", name);
  fs.mkdirSync(root, { recursive: true });
  /** @type {Error | undefined} */
  let failure;
  try {
    if (name === "containment") {
      await containment(root, harness);
    } else {
      await registryProof(root, harness, name);
    }
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error("isolation proof failed", { cause: error });
  } finally {
    for (const config of ownedConfigurations) {
      try {
        cleanupContainers(config);
      } catch (error) {
        failure ??=
          error instanceof Error ? error : new Error("owned cleanup failed", { cause: error });
      }
    }
  }
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify({
      name,
      head: process.env.HARNESS_SHA,
      passed: !failure,
      ...(failure ? { error: failure.message } : {}),
    }),
  );
  if (failure) {
    throw failure;
  }
  console.log(`Install isolation case passed: ${name}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Installer isolation proof failed; inspect the uploaded result and command artifacts.",
    );
    process.exitCode = 1;
  });
}
