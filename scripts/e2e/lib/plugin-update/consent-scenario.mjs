// Exercise consent through the installed CLI, including its post-core child process.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureCapabilityConsentArgs } from "../package-compat.mjs";

const [entry, coreTarball] = process.argv.slice(2);
assert(entry && coreTarball, "expected installed entry and canonical core tarball");
const coreTarballSha256 = execFileSync("sha256sum", [coreTarball], { encoding: "utf8" }).split(
  /\s+/,
)[0];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-consent-"));
const pluginId = "update-consent-fixture";
const packageName = `@acme/${pluginId}`;
const groups = [
  "channels",
  "providers",
  "tools",
  "contracts",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
];
const artifacts = new Map();
const runs = [];
const snapshots = [];
let registry;
let registryPort;

function expectedSurface(version) {
  const tools = Array.from({ length: version }, (_, index) => `consent_tool_${index + 1}`);
  return Object.fromEntries(
    groups.map((group) => [
      group,
      group === "tools"
        ? tools
        : group === "contracts"
          ? tools.map((name) => `tools: ${name}`)
          : [],
    ]),
  );
}

// Inspect only this command's descendants and the existing post-core marker.
// process.title overwrites Linux argv, so retain argv before that mutation.
function descendants(pid, seen = new Map()) {
  try {
    const children = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const child of children) {
      const argv = fs.readFileSync(`/proc/${child}/cmdline`, "utf8").split("\0").filter(Boolean);
      const postCore =
        (argv.includes("update") || argv[0] === "openclaw-update") &&
        fs
          .readFileSync(`/proc/${child}/environ`, "utf8")
          .split("\0")
          .includes("OPENCLAW_UPDATE_POST_CORE=1");
      const previous = seen.get(child);
      seen.set(child, {
        pid: child,
        argv: previous?.argv.includes("update") ? previous.argv : argv,
        postCore: previous?.postCore || postCore,
      });
      descendants(child, seen);
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") {
      throw error;
    }
  }
  return seen;
}

async function cli(label, args, { allowFailure = false } = {}) {
  const stdout = path.join(root, `${label}.stdout`);
  const stderr = path.join(root, `${label}.stderr`);
  const out = fs.openSync(stdout, "w");
  const err = fs.openSync(stderr, "w");
  const child = spawn(
    "bash",
    [
      "-e",
      "-c",
      'source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_run_command "$@"',
      "consent-cli",
      process.execPath,
      entry,
      ...args,
    ],
    { stdio: ["ignore", out, err] },
  );
  const observed = new Map();
  const observer = setInterval(() => descendants(child.pid, observed), 20);
  let code;
  try {
    [code] = await once(child, "exit");
  } finally {
    clearInterval(observer);
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const output = fs.readFileSync(stdout, "utf8");
  const diagnostic = fs.readFileSync(stderr, "utf8");
  if (!allowFailure) {
    assert.equal(code, 0, `${label} failed: ${output}\n${diagnostic}`);
  }
  let result;
  if (args[0] === "update" && args.includes("--json")) {
    assert.doesNotThrow(() => {
      result = JSON.parse(output);
    }, `${label} did not return JSON: ${output}\n${diagnostic}`);
  }
  runs.push({
    label,
    args,
    code,
    stdout,
    stderr,
    children: [...observed.values()].filter(
      (descendant) => descendant.argv.includes("update") || descendant.postCore,
    ),
    ...(result ? { result } : {}),
  });
  fs.writeFileSync(path.join(root, "runs.json"), JSON.stringify(runs, null, 2));
  console.log(JSON.stringify({ event: "consent-command", ...runs.at(-1) }));
  return { code, output, diagnostic, children: [...observed.values()] };
}

async function stopRegistry() {
  if (!registry) {
    return;
  }
  if (registry.exitCode === null && registry.signalCode === null) {
    const stopped = once(registry, "exit");
    registry.kill("SIGTERM");
    await stopped;
  }
  registry = undefined;
}

async function serve(version) {
  await stopRegistry();
  const portFile = path.join(root, `registry-${version}.port`);
  const args = Array.from({ length: version }, (_, i) => i + 1).flatMap((v) => [
    packageName,
    `${v}.0.0`,
    artifacts.get(v).tarball,
  ]);
  registry = spawn(
    process.execPath,
    ["scripts/e2e/lib/plugins/npm-registry-server.mjs", portFile, ...args],
    {
      env: {
        ...process.env,
        OPENCLAW_NPM_REGISTRY_PORT: String(registryPort ?? 0),
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt++) {
    assert.equal(registry.exitCode, null, "fixture registry exited");
    await delay(100);
  }
  registryPort = Number(fs.readFileSync(portFile, "utf8"));
  process.env.NPM_CONFIG_REGISTRY = `http://127.0.0.1:${registryPort}`;
  process.env.npm_config_registry = process.env.NPM_CONFIG_REGISTRY;
}

async function snapshot(label, version) {
  const report = JSON.parse(
    (await cli(label, ["plugins", "inspect", pluginId, "--runtime", "--json"])).output,
  );
  assert.equal(report.plugin.status, "loaded");
  const record = report.install;
  assert.equal(record.version, `${version}.0.0`);
  assert.deepEqual(
    report.tools.flatMap((tool) => tool.names).toSorted(),
    expectedSurface(version).tools,
  );
  const surface = expectedSurface(version);
  assert.deepEqual(record.acceptedSurface, surface);
  assert.equal(
    record.acceptedSurfaceHash,
    createHash("sha256").update(JSON.stringify(surface)).digest("hex"),
  );
  assert.equal(record.acceptedSurfaceIntegrity, artifacts.get(version).integrity);
  assert.equal(record.integrity, artifacts.get(version).integrity);
  assert(record.acceptedSurfaceAt);
  const bytes = fs.readFileSync(path.join(record.installPath, "index.js"), "utf8");
  assert.equal(bytes, artifacts.get(version).code);
  snapshots.push({
    label,
    record,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { record, bytes };
}

try {
  const help = await cli("update-help", ["update", "--help"]);
  if (fixtureCapabilityConsentArgs(help.output).length === 0) {
    console.log(
      "Capability update scenario skipped: historical candidate has no explicit update consent flag.",
    );
  } else {
    for (const version of [1, 2, 3]) {
      const dir = path.join(root, `v${version}`, "package");
      fs.mkdirSync(dir, { recursive: true });
      const tools = expectedSurface(version).tools;
      const code = `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) { for (const name of ${JSON.stringify(tools)}) api.registerTool(() => null, { name }); } };\n`;
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: packageName,
          version: `${version}.0.0`,
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      fs.writeFileSync(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          contracts: { tools },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      fs.writeFileSync(path.join(dir, "index.js"), code);
      const tarball = path.join(root, `fixture-${version}.tgz`);
      execFileSync("tar", ["-czf", tarball, "-C", path.dirname(dir), "package"]);
      artifacts.set(version, {
        tarball,
        code,
        integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`,
      });
    }
    await serve(1);
    await cli("initial-install", [
      "plugins",
      "install",
      `npm:${packageName}`,
      "--force",
      "--accept-capabilities",
    ]);
    const initial = await snapshot("initial", 1);
    assert.equal(
      initial.record.spec,
      packageName,
      "updates must keep an unpinned registry selector",
    );
    await serve(2);
    const denied = await cli("update-denied", [
      "update",
      "--tag",
      coreTarball,
      "--yes",
      "--no-restart",
      "--json",
    ]);
    const deniedResult = JSON.parse(denied.output);
    assert.match(JSON.stringify(deniedResult), /capabilit/i);
    assert(
      denied.children.some((child) => child.postCore),
      "denied update did not hand off",
    );
    assert.deepEqual(await snapshot("after-denial", 1), initial);
    await cli("repair-accepted", ["update", "repair", "--accept-capabilities", "--yes", "--json"]);
    const repaired = await snapshot("repaired", 2);
    await serve(3);
    await cli("later-repair-denied", ["update", "repair", "--yes", "--json"]);
    assert.deepEqual(await snapshot("no-future-permission", 2), repaired);
    const accepted = await cli("update-accepted", [
      "update",
      "--tag",
      coreTarball,
      "--accept-capabilities",
      "--yes",
      "--no-restart",
      "--json",
    ]);
    JSON.parse(accepted.output);
    assert(
      accepted.children.some((child) => child.postCore),
      "accepted update did not hand off to a fresh post-core process",
    );
    const final = await snapshot("fresh-process-accepted", 3);
    const payload = path.join(final.record.installPath, "index.js");
    assert(
      final.record.installPath.startsWith(process.env.OPENCLAW_STATE_DIR + path.sep),
      "fixture payload must belong to isolated state",
    );
    fs.rmSync(final.record.installPath, { recursive: true });
    const missing = await cli("missing-payload-denied", ["update", "repair", "--yes", "--json"], {
      allowFailure: true,
    });
    assert.match(JSON.stringify(JSON.parse(missing.output)), /capabilit/i);
    assert.equal(fs.existsSync(payload), false, "missing payload was repaired without consent");
    await cli("missing-payload-accepted", [
      "update",
      "repair",
      "--accept-capabilities",
      "--yes",
      "--json",
    ]);
    await snapshot("missing-payload-recovered", 3);
    console.log(
      JSON.stringify(
        {
          status: "passed",
          root,
          coreTarballSha256,
          assertions: [
            "no-consent preserves old payload and record",
            "repair accepts exact surface and integrity",
            "acceptance grants no future widening",
            "fresh-process update receives consent",
            "runtime exposes precisely reviewed tools",
            "missing payload requires consent before repair",
          ],
          runs,
          snapshots,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await stopRegistry();
}
