import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledRuntimeDependencyInstallRoot } from "./bundled-runtime-deps.js";
import { prepareBundledPluginRuntimeRoot } from "./bundled-runtime-root.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-runtime-root-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("prepareBundledPluginRuntimeRoot", () => {
  it("materializes plugin-owned root chunks in external mirrors", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "browser");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.24", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "pw-ai.js"),
      [
        `//#region extensions/browser/src/pw-ai.ts`,
        `import { marker } from "playwright-core";`,
        `export { marker };`,
        `//#endregion`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `import { marker } from "../../pw-ai.js"; export default { id: "browser", marker };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/browser",
          version: "1.0.0",
          type: "module",
          dependencies: {
            "playwright-core": "1.0.0",
          },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    const depRoot = path.join(installRoot, "node_modules", "playwright-core");
    fs.mkdirSync(depRoot, { recursive: true });
    fs.writeFileSync(
      path.join(depRoot, "package.json"),
      JSON.stringify({
        name: "playwright-core",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(depRoot, "index.js"), "export const marker = 'stage-ok';\n", "utf8");

    const staleMirrorChunk = path.join(installRoot, "dist", "pw-ai.js");
    fs.mkdirSync(path.dirname(staleMirrorChunk), { recursive: true });
    fs.symlinkSync(path.join(packageRoot, "dist", "pw-ai.js"), staleMirrorChunk, "file");

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "browser",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(path.join(installRoot, "dist", "extensions", "browser"));
    expect(prepared.modulePath).toBe(path.join(prepared.pluginRoot, "index.js"));
    expect(fs.lstatSync(staleMirrorChunk).isSymbolicLink()).toBe(false);

    const preparedAgain = prepareBundledPluginRuntimeRoot({
      pluginId: "browser",
      pluginRoot: prepared.pluginRoot,
      modulePath: prepared.modulePath,
      env,
    });

    expect(preparedAgain).toEqual(prepared);
    expect(fs.existsSync(staleMirrorChunk)).toBe(true);
    expect(fs.lstatSync(staleMirrorChunk).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(staleMirrorChunk, "utf8")).toContain("playwright-core");
  });

  it("does not copy staged runtime mirror dist files onto themselves", () => {
    const stageDir = makeTempRoot();
    const installRoot = path.join(stageDir, "openclaw-2026.4.26-alpha");
    const pluginRoot = path.join(installRoot, "dist", "extensions", "qqbot");
    const distChunk = path.join(installRoot, "dist", "accounts-abc123.js");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.26", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(distChunk, "export const marker = 'same-root';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `import { marker } from "../../accounts-abc123.js"; export default { id: "qqbot", marker };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(pluginRoot);
    expect(prepared.modulePath).toBe(path.join(pluginRoot, "index.js"));
    expect(fs.readFileSync(distChunk, "utf8")).toContain("same-root");
  });
});
