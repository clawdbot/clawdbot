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
import { readPluginInstallIndex } from "../plugin-index-sqlite.mjs";
import { observePostCoreCommand } from "./process-observer.mjs";

// Without a core tarball, run only the plugin reinstall boundary against the supplied CLI.
export async function runConsentScenario(entry, coreTarball) {
  assert(entry, "expected CLI entry");
  let coreTarballSha256;
  if (coreTarball) {
    const coreHash = createHash("sha256");
    for await (const chunk of fs.createReadStream(coreTarball)) {
      coreHash.update(chunk);
    }
    coreTarballSha256 = coreHash.digest("hex");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-consent-"));
  const pluginId = "update-consent-fixture";
  const packageName = `@acme/${pluginId}`;
  const capabilityConsentRequired = "PLUGIN_CAPABILITY_CONSENT_REQUIRED";
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
    let code;
    let children;
    try {
      ({ code, children } = await observePostCoreCommand(child, label));
    } finally {
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
      children: children.filter(
        (descendant) => descendant.argv.includes("update") || descendant.postCore,
      ),
      ...(result ? { result } : {}),
    });
    fs.writeFileSync(path.join(root, "runs.json"), JSON.stringify(runs, null, 2));
    console.log(JSON.stringify({ event: "consent-command", ...runs.at(-1) }));
    return { code, output, diagnostic, children };
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
          OPENCLAW_NPM_REGISTRY_UPSTREAM:
            process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL || "https://registry.npmjs.org",
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

  async function snapshot(label, version, enabled = true) {
    const report = JSON.parse(
      (await cli(label, ["plugins", "inspect", pluginId, "--runtime", "--json"])).output,
    );
    assert.equal(report.plugin.status, enabled ? "loaded" : "disabled");
    assert.equal(report.plugin.enabled, enabled);
    const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
    assert.equal(config.plugins.entries[pluginId].enabled, enabled);
    const record = report.install;
    assert.equal(record.version, `${version}.0.0`);
    assert.deepEqual(
      report.tools.flatMap((tool) => tool.names).toSorted(),
      enabled ? expectedSurface(version).tools : [],
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
    const pkg = JSON.parse(fs.readFileSync(path.join(record.installPath, "package.json"), "utf8"));
    assert.equal(pkg.version, `${version}.0.0`);
    snapshots.push({
      label,
      enabled,
      record,
      payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    return { record, bytes };
  }

  function assertConsentBlocked(command, result, expectedReason) {
    assert.equal(command.code, 1, `${command.output}\n${command.diagnostic}`);
    assert.equal(result.status, "error");
    if (expectedReason) {
      assert.equal(result.reason, expectedReason);
    }
    assert.equal(result.postUpdate?.plugins?.status, "error");
    assert.equal(
      result.postUpdate?.plugins?.npm?.outcomes?.find(
        (outcome) => outcome.pluginId === pluginId && outcome.status === "error",
      )?.code,
      capabilityConsentRequired,
    );
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
        const filename = execFileSync("npm", ["pack", "--pack-destination", root, "--silent"], {
          cwd: dir,
          encoding: "utf8",
        }).trim();
        const tarball = path.join(root, filename);
        artifacts.set(version, {
          tarball,
          code,
          integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`,
        });
      }
      const reinstall = (version) => [
        "plugins",
        "install",
        `npm-pack:${artifacts.get(version).tarball}`,
        "--force",
      ];
      await cli("reinstall-initial", [...reinstall(1), "--accept-capabilities"]);
      await snapshot("reinstall-initial-state", 1);
      await cli("disable", ["plugins", "disable", pluginId]);
      await cli("reinstall-unchanged", reinstall(1));
      const disabled = await snapshot("reinstall-unchanged-disabled", 1, false);
      const configBefore = fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8");
      const indexBefore = readPluginInstallIndex();
      assert.deepEqual(indexBefore.installRecords[pluginId], disabled.record);
      const rejected = await cli("reinstall-widened-denied", reinstall(2), { allowFailure: true });
      assert.equal(rejected.code, 1, `${rejected.output}\n${rejected.diagnostic}`);
      assert.match(rejected.output + rejected.diagnostic, /requires capability consent/i);
      assert.equal(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"), configBefore);
      assert.deepEqual(readPluginInstallIndex(), indexBefore);
      assert.deepEqual(await snapshot("reinstall-denied-preserved", 1, false), disabled);
      await cli("reinstall-widened-accepted", [...reinstall(2), "--accept-capabilities"]);
      const acceptedDisabled = await snapshot("reinstall-accepted-disabled", 2, false);
      assert.deepEqual(readPluginInstallIndex().installRecords[pluginId], acceptedDisabled.record);
      await cli("reinstall-enable", ["plugins", "enable", pluginId]);
      assert.deepEqual(await snapshot("reinstall-enabled", 2), acceptedDisabled);
      const reinstallAssertions = [
        "unchanged forced reinstall reuses acceptance and preserves authored disablement",
        "widened forced reinstall without consent preserves config, package, and SQLite index",
        "accepted forced reinstall replaces package and acceptance while remaining disabled",
        "explicit enable activates the reviewed replacement",
      ];
      if (!coreTarball) {
        console.log(
          JSON.stringify(
            { status: "passed", root, assertions: reinstallAssertions, runs, snapshots },
            null,
            2,
          ),
        );
        return;
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
      const denied = await cli(
        "update-denied",
        ["update", "--tag", coreTarball, "--yes", "--json"],
        { allowFailure: true },
      );
      const deniedResult = JSON.parse(denied.output);
      assertConsentBlocked(denied, deniedResult, "post-update-plugins");
      assert(
        !denied.children.some(
          (child) => child.argv.includes("gateway") && child.argv.includes("restart"),
        ),
        "denied update attempted a Gateway restart",
      );
      assert(
        denied.children.some((child) => child.postCore),
        "denied update did not hand off",
      );
      assert.deepEqual(await snapshot("after-denial", 1), initial);
      await cli("repair-accepted", [
        "update",
        "repair",
        "--accept-capabilities",
        "--yes",
        "--json",
      ]);
      const repaired = await snapshot("repaired", 2);
      await serve(3);
      const laterDenied = await cli(
        "later-repair-denied",
        ["update", "repair", "--yes", "--json"],
        { allowFailure: true },
      );
      assertConsentBlocked(laterDenied, JSON.parse(laterDenied.output));
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
              ...reinstallAssertions,
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
}
