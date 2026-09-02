// Fixture Plugin Commands tests cover shared E2E plugin fixture writers.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const FIXTURE_SCRIPT = "scripts/e2e/lib/fixture.mjs";
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runFixture(command: string, args: string[]) {
  return spawnSync(process.execPath, [FIXTURE_SCRIPT, command, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("plugin fixture commands", () => {
  it("writes plugin fixtures with manifest and package metadata", () => {
    const root = makeTempDir(tempDirs, "openclaw-fixture-plugin-");
    const pluginRoot = path.join(root, "demo");

    const result = runFixture("plugin", [
      pluginRoot,
      "demo-plugin",
      "0.1.0",
      "demo.ping",
      "Demo Plugin",
    ]);

    expect(result.status).toBe(0);
    expect(readJson(path.join(pluginRoot, "package.json"))).toMatchObject({
      name: "@openclaw/demo-plugin",
      version: "0.1.0",
      openclaw: { extensions: ["./index.js"] },
    });
    expect(readJson(path.join(pluginRoot, "openclaw.plugin.json"))).toMatchObject({
      id: "demo-plugin",
      configSchema: { type: "object", properties: {} },
    });
    expect(readFileSync(path.join(pluginRoot, "index.js"), "utf8")).toContain("demo.ping");
  });

  it("writes CLI plugin fixtures with local dependency metadata", () => {
    const root = makeTempDir(tempDirs, "openclaw-fixture-plugin-cli-");
    const pluginRoot = path.join(root, "cli-demo");

    const result = runFixture("plugin-cli", [
      pluginRoot,
      "demo-cli",
      "0.2.0",
      "demo.cli",
      "Demo CLI",
      "demo-cli",
      "demo-cli:pong",
    ]);

    expect(result.status).toBe(0);
    expect(readJson(path.join(pluginRoot, "package.json"))).toMatchObject({
      dependencies: { "is-number": "file:./deps/is-number" },
    });
    expect(readJson(path.join(pluginRoot, "deps", "is-number", "package.json"))).toMatchObject({
      name: "is-number",
      version: "7.0.0",
    });
    const source = readFileSync(path.join(pluginRoot, "index.js"), "utf8");
    expect(source).toContain("demo-cli:pong");
    expect(source).toContain("registerCli");
  });

  it("rejects plugin fixture commands with missing required args", () => {
    const root = makeTempDir(tempDirs, "openclaw-fixture-plugin-missing-");

    const result = runFixture("plugin", [path.join(root, "missing"), "demo-plugin"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("version is required");
  });
});
