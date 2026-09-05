import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeAgentSdkAssetPlugin } from "../../scripts/lib/claude-agent-sdk-assets.mts";

const sdkPackage = "@anthropic-ai/claude-agent-sdk";
const sdkSourceDir = path.dirname(createRequire(import.meta.url).resolve(sdkPackage));
const tempDirs: string[] = [];

async function createFixture() {
  const rootDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-assets-")),
  );
  tempDirs.push(rootDir);
  const sdkDir = path.join(rootDir, "node_modules", sdkPackage);
  await fs.cp(sdkSourceDir, sdkDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });
  await fs.writeFile(path.join(rootDir, "package.json"), '{"type":"module"}\n');
  const entries: Record<string, string> = {};
  for (const prefix of ["", "extensions/anthropic/"]) {
    for (const kind of ["dynamic", "static"]) {
      const name = `${prefix}${kind}`;
      const source = path.join(rootDir, `${name.replaceAll("/", "-")}.mjs`);
      const specifier = JSON.stringify(sdkPackage);
      const code =
        kind === "dynamic"
          ? `export const loadSdk = () => import(${specifier});
             export async function* queryExports() {
               const { query } = await import(${specifier});
               yield query;
             }`
          : `import * as sdk from ${specifier}; export { sdk }; export * from ${specifier};`;
      await fs.writeFile(source, code);
      entries[name] = source;
    }
  }
  return { rootDir, sdkDir, entries };
}

// This child implements only the fixture side of the published SDK stdio contract.
// The real SDK owns framing, callback routing, and reuse of the same process.
const fixtureCli = `
  import assert from "node:assert/strict";
  import { createInterface } from "node:readline";
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  let hookId;
  let turn = 0;
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request.subtype === "initialize") {
      hookId = message.request.hooks.PreToolUse[0].hookCallbackIds[0];
      send({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id, response: { commands: [], models: [] }
      }});
    } else if (message.type === "user") {
      assert.ok(hookId);
      turn++;
      send({ type: "control_request", request_id: "hook", request: {
        subtype: "hook_callback", callback_id: hookId, tool_use_id: "tool-" + turn,
        input: { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "fixture.txt" } }
      }});
    } else if (message.type === "control_response" && message.response.request_id === "hook") {
      assert.equal(message.response.response.continue, true);
      send({ type: "control_request", request_id: "permission", request: {
        subtype: "can_use_tool", tool_name: "Read", input: { file_path: "fixture.txt" }, tool_use_id: "tool-" + turn
      }});
    } else if (message.type === "control_response" && message.response.request_id === "permission") {
      assert.equal(message.response.response.behavior, "deny");
      send({ type: "result", subtype: "success", is_error: false,
        result: "denied-" + turn, session_id: "fixture-session" });
    } else {
      throw new Error("Unexpected fixture protocol message: " + message.type);
    }
  }
`;

const runtimeProbe = `
  import assert from "node:assert/strict";
  import { spawn } from "node:child_process";
  import { PassThrough } from "node:stream";
  const [entry, nestedEntry, staticEntry, nestedStaticEntry, executable] = process.argv.slice(1);
  const dynamicModules = await Promise.all([entry, nestedEntry].map((file) => import(file)));
  const sdk = await dynamicModules[0].loadSdk();
  for (const module of dynamicModules) {
    assert.equal(await module.loadSdk(), sdk);
    for await (const query of module.queryExports()) assert.equal(query, sdk.query);
  }
  for (const file of [staticEntry, nestedStaticEntry]) {
    const module = await import(file);
    assert.equal(module.sdk, sdk);
    assert.deepEqual(Object.keys(module).filter((name) => name !== "sdk").sort(), Object.keys(sdk).sort());
    for (const [name, value] of Object.entries(sdk)) assert.equal(module[name], value);
  }
  assert.throws(() => sdk.query({ prompt: "fixture" }), /Native CLI binary/);
  let spawns = 0, permissions = 0, hooks = 0;
  const prompts = new PassThrough({ objectMode: true });
  const query = sdk.query({ prompt: prompts, options: {
    pathToClaudeCodeExecutable: executable,
    executable: process.execPath,
    cwd: process.cwd(), env: process.env, settingSources: [],
    spawnClaudeCodeProcess(options) {
      spawns++;
      assert.equal(options.command, process.execPath);
      assert.equal(options.args[0], executable);
      assert.ok(options.args.includes("--permission-prompt-tool"));
      return spawn(options.command, options.args, {
        cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "inherit"]
      });
    },
    canUseTool: async (name, input) => {
      assert.equal(name, "Read");
      assert.equal(input.file_path, "fixture.txt");
      permissions++;
      return { behavior: "deny", message: "Fixture denied the read." };
    },
    hooks: { PreToolUse: [{ hooks: [async (input) => {
      assert.equal(input.hook_event_name, "PreToolUse");
      hooks++;
      return { continue: true };
    }] }] }
  }});
  const prompt = () => prompts.write({ type: "user", session_id: "", parent_tool_use_id: null,
    message: { role: "user", content: "fixture" } });
  const results = [];
  prompt();
  try {
    for await (const message of query) {
      if (message.type !== "result") continue;
      results.push(message.result);
      if (results.length === 1) prompt();
      else prompts.end();
    }
  } finally { query.close(); prompts.destroy(); }
  process.stdout.write(JSON.stringify({ results, spawns, permissions, hooks }));
`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Claude Agent SDK package assets", () => {
  it("preserves root and nested SDK imports through tsdown without native packages", async () => {
    const { rootDir, sdkDir, entries } = await createFixture();
    const sourceManifest = JSON.parse(await fs.readFile(path.join(sdkDir, "package.json"), "utf8"));
    const outputDir = path.join(rootDir, "artifact");
    // Use the production build wrapper: its dependency resolver forwards Rolldown
    // resolutions and can lose forced-relative metadata when it wraps the SDK resolver.
    await build({
      config: false,
      cwd: rootDir,
      entry: entries,
      outDir: outputDir,
      outExtensions: () => ({ js: ".js" }),
      fixedExtension: false,
      dts: false,
      logLevel: "silent",
      plugins: [createClaudeAgentSdkAssetPlugin(rootDir)],
    });
    const assetDir = path.join(outputDir, "extensions/anthropic/agent-sdk");
    const packagedManifest = JSON.parse(
      await fs.readFile(path.join(assetDir, "package.json"), "utf8"),
    );
    const { optionalDependencies, ...expectedManifest } = sourceManifest;
    expect(Object.keys(optionalDependencies).length).toBeGreaterThan(0);
    expect(packagedManifest).toEqual(expectedManifest);
    for (const file of [...sourceManifest.files, "LICENSE.md", "README.md"]) {
      expect(await fs.readFile(path.join(assetDir, file))).toEqual(
        await fs.readFile(path.join(sdkDir, file)),
      );
    }
    // Remove the source dependency tree: bare imports or accidental native fallback must fail.
    await fs.rm(path.join(rootDir, "node_modules"), { recursive: true });
    const executable = path.join(rootDir, "installed-claude.mjs");
    await fs.writeFile(executable, fixtureCli);
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        runtimeProbe,
        pathToFileURL(path.join(outputDir, "dynamic.js")).href,
        pathToFileURL(path.join(outputDir, "extensions/anthropic/dynamic.js")).href,
        pathToFileURL(path.join(outputDir, "static.js")).href,
        pathToFileURL(path.join(outputDir, "extensions/anthropic/static.js")).href,
        executable,
      ],
      {
        cwd: rootDir,
        timeout: 15_000,
        encoding: "utf8",
        env: {
          HOME: rootDir,
          USERPROFILE: rootDir,
          CLAUDE_CONFIG_DIR: rootDir,
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TMPDIR: rootDir,
          TEMP: rootDir,
        },
      },
    );
    expect(JSON.parse(output)).toEqual({
      results: ["denied-1", "denied-2"],
      spawns: 1,
      permissions: 2,
      hooks: 2,
    });
  });

  it.each(["optionalDependencies", "dependencies"])(
    "rejects an unreviewed non-native %s entry rather than silently dropping its runtime",
    async (field) => {
      const { rootDir, sdkDir } = await createFixture();
      const manifestPath = path.join(sdkDir, "package.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      manifest[field] = { ...manifest[field], "fixture-runtime": "1.0.0" };
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      expect(() => createClaudeAgentSdkAssetPlugin(rootDir)).toThrow("dependency layout changed");
    },
  );
});
