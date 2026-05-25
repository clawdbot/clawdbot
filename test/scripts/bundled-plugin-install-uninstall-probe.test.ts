import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const probePath = path.resolve("scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs");
const runtimeSmokePath = path.resolve(
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
);

type PluginListEntry = {
  id: string;
  origin: string;
  rootDir: string;
};

function makePackageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-probe-"));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  return root;
}

function writePluginsList(root: string, plugins: PluginListEntry[]): void {
  fs.writeFileSync(
    path.join(root, "dist", "index.js"),
    [
      `const plugins = ${JSON.stringify(plugins)};`,
      "if (process.argv.slice(2).join(' ') !== 'plugins list --json') {",
      "  console.error(`unexpected argv: ${process.argv.slice(2).join(' ')}`);",
      "  process.exit(1);",
      "}",
      "console.log(JSON.stringify({ plugins }));",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writePluginManifest(root: string, pluginRoot: string, manifest: Record<string, unknown>) {
  const dir = path.join(root, pluginRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function runProbe(root: string, env: Record<string, string | undefined> = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) {
      delete childEnv[key];
    }
  }
  childEnv.OPENCLAW_ENTRY = path.join(root, "dist", "index.js");
  return spawnSync(process.execPath, [probePath, "select"], {
    cwd: root,
    encoding: "utf8",
    env: childEnv as NodeJS.ProcessEnv,
  });
}

function runProbeCommand(root: string, args: string[], env: Record<string, string | undefined>) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) {
      delete childEnv[key];
    }
  }
  childEnv.OPENCLAW_ENTRY = path.join(root, "dist", "index.js");
  return spawnSync(process.execPath, [probePath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: childEnv as NodeJS.ProcessEnv,
  });
}

function runRuntimeSmoke(root: string, args: string[]) {
  return spawnSync(process.execPath, [runtimeSmokePath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_ENTRY: path.join(root, "dist", "index.js"),
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("bundled plugin install/uninstall probe", () => {
  it("selects packaged installable bundled sources instead of raw dist extension dirs", () => {
    const root = makePackageRoot();
    fs.mkdirSync(path.join(root, "dist", "extensions", "qa-channel"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "extensions", "qa-channel", "openclaw.plugin.json"),
      '{"id":"qa-channel"}\n',
      "utf8",
    );
    writePluginManifest(root, "dist-runtime/extensions/admin-http-rpc", {
      id: "admin-http-rpc",
      configSchema: { required: ["port"] },
    });
    writePluginsList(root, [
      {
        id: "admin-http-rpc",
        origin: "bundled",
        rootDir: path.join(root, "dist-runtime", "extensions", "admin-http-rpc"),
      },
    ]);

    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `admin-http-rpc\tadmin-http-rpc\t1\t${path.join(root, "dist-runtime", "extensions", "admin-http-rpc")}`,
    );
  });

  it("fails explicit ids that are not installable in the packaged runtime", () => {
    const root = makePackageRoot();
    writePluginManifest(root, "dist-runtime/extensions/admin-http-rpc", {
      id: "admin-http-rpc",
    });
    writePluginsList(root, [
      {
        id: "admin-http-rpc",
        origin: "bundled",
        rootDir: path.join(root, "dist-runtime", "extensions", "admin-http-rpc"),
      },
    ]);

    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS: "qa-channel",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS entry is not an installable bundled plugin in this package: qa-channel",
    );
    expect(result.stderr).toContain("Available: admin-http-rpc");
  });

  it("loads runtime smoke manifests from the selected packaged root", () => {
    const root = makePackageRoot();
    writePluginManifest(root, "dist/extensions/runtime-only", {
      id: "runtime-only",
      contracts: { speechProviders: ["stale-provider"] },
    });
    fs.mkdirSync(path.join(root, "dist-runtime", "extensions", "runtime-only"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "dist-runtime", "extensions", "runtime-only", "openclaw.plugin.json"),
      '{"id":"runtime-only"}\n',
      "utf8",
    );

    const result = runRuntimeSmoke(root, [
      "tts-global-disable",
      "runtime-only",
      "runtime-only",
      "0",
      "0",
      path.join(root, "dist-runtime", "extensions", "runtime-only"),
      "",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Global-disable TTS smoke skipped for runtime-only: no speech provider contract",
    );
  });

  it("accepts native Windows bundled source paths when asserting install state", () => {
    const root = makePackageRoot();
    const stateDir = path.join(root, "state");
    const windowsSourcePath = "C:\\crabbox\\qa-windows\\dist\\extensions\\nostr";
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { nostr: { enabled: true } } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, "plugins", "installs.json"),
      JSON.stringify({
        installRecords: {
          nostr: {
            source: "path",
            sourcePath: windowsSourcePath,
            installPath: windowsSourcePath,
          },
        },
      }),
      "utf8",
    );
    writePluginsList(root, []);

    const result = runProbeCommand(root, ["assert-installed", "nostr", "nostr", "0"], {
      HOME: undefined,
      OPENCLAW_STATE_DIR: stateDir,
    });

    expect(result.status).toBe(0);
  });

  it("detects native Windows bundled load paths after uninstall", () => {
    const root = makePackageRoot();
    const stateDir = path.join(root, "state");
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        plugins: { load: { paths: ["C:\\crabbox\\qa-windows\\dist\\extensions\\nostr"] } },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, "plugins", "installs.json"),
      JSON.stringify({ installRecords: {} }),
      "utf8",
    );
    writePluginsList(root, []);

    const result = runProbeCommand(root, ["assert-uninstalled", "nostr", "nostr"], {
      HOME: undefined,
      OPENCLAW_STATE_DIR: stateDir,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("load path still present after uninstall for nostr");
  });
});
