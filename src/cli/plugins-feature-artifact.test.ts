import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { extract } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadToolPlugin,
  runPluginsBuildCommand,
  runPluginsInitCommand,
} from "./plugins-authoring-command.js";
import { packFeaturePlugin } from "./plugins-feature-artifact.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feature-pack-"));
  directories.push(parent);
  const rootDir = path.join(parent, "draft-review");
  await runPluginsInitCommand("draft-review", { directory: rootDir, type: "feature" });
  await fs.symlink(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "dir");
  await build({
    absWorkingDir: rootDir,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["openclaw/*"],
    logLevel: "silent",
  });
  await fs.writeFile(
    path.join(rootDir, "dist/name.cjs"),
    'module.exports = require("node:path").basename("/fixtures/Draft Review");',
  );
  await fs.appendFile(
    path.join(rootDir, "dist/index.js"),
    '\nimport label from "./name.cjs"; if (label !== "Draft Review") throw new Error("CommonJS dependency failed");\n',
  );
  await runPluginsBuildCommand({ root: rootDir });
  return { rootDir, parent };
}

describe("plugin artifact authoring", () => {
  it("packs the scaffold into a self-contained import bound to its exact digest", async () => {
    const { rootDir, parent } = await fixture();
    const receipt = await packFeaturePlugin({ root: rootDir });
    const bytes = await fs.readFile(receipt.path);
    expect(receipt.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const extracted = path.join(parent, "extracted");
    await fs.mkdir(extracted);
    await extract({ file: receipt.path, cwd: extracted, strict: true });
    const packageRoot = path.join(extracted, "package");
    const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    expect(metadata.dependencies).toBeUndefined();
    expect(metadata.scripts).toBeUndefined();
    expect(metadata.openclaw.controlUi).toBeUndefined();
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "openclaw.plugin.json"), "utf8"),
    );
    expect(await fs.readFile(path.join(packageRoot, manifest.controlUi.entry), "utf8")).toContain(
      "Draft composer",
    );
    const loaded = await loadToolPlugin({
      rootDir: packageRoot,
      entryPath: path.join(packageRoot, "dist/index.js"),
    });
    expect(loaded.metadata.id).toBe("draft-review");
    expect(loaded.metadata.tools.map((tool) => tool.name)).toEqual(["draft_review_analyze"]);
    await fs.writeFile(path.join(rootDir, "src/control-ui.ts"), "export default null;");
    expect(await fs.readFile(receipt.path)).toEqual(bytes);
  });

  it("rejects stale browser source and never overwrites an existing approval artifact", async () => {
    const { rootDir, parent } = await fixture();
    const out = path.join(parent, "review.tgz");
    await fs.writeFile(out, "existing review");
    await expect(packFeaturePlugin({ root: rootDir, out })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(out, "utf8")).toBe("existing review");
    await fs.writeFile(path.join(rootDir, "src/control-ui.ts"), "export default null;");
    await expect(packFeaturePlugin({ root: rootDir })).rejects.toThrow("missing or stale");
    await expect(fs.stat(path.join(rootDir, "draft-review.tgz"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
