import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyBundledPluginMetadata,
  rewritePackageExtensions,
} from "../../scripts/copy-bundled-plugin-metadata.mjs";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../test/helpers/temp-repo.js";

const tempDirs: string[] = [];
const excludeOptionalEnv = { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "0" } as const;
const copyBundledPluginMetadataWithEnv = copyBundledPluginMetadata as (params?: {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
}) => void;

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeJson(filePath: string, value: unknown): void {
  writeJsonFile(filePath, value);
}

function createPlugin(
  repoRoot: string,
  params: {
    id: string;
    packageName: string;
    manifest?: Record<string, unknown>;
    packageOpenClaw?: Record<string, unknown>;
  },
) {
  const pluginDir = path.join(repoRoot, "extensions", params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: params.id,
    configSchema: { type: "object" },
    ...params.manifest,
  });
  writeJson(path.join(pluginDir, "package.json"), {
    name: params.packageName,
    ...(params.packageOpenClaw ? { openclaw: params.packageOpenClaw } : {}),
  });
  return pluginDir;
}

function readBundledManifest(repoRoot: string, pluginId: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "dist", "extensions", pluginId, "openclaw.plugin.json"),
      "utf8",
    ),
  ) as { skills?: string[] };
}

function readBundledPackageJson(repoRoot: string, pluginId: string) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, "dist", "extensions", pluginId, "package.json"), "utf8"),
  ) as { openclaw?: { extensions?: string[] } };
}

function bundledPluginDir(repoRoot: string, pluginId: string) {
  return path.join(repoRoot, "dist", "extensions", pluginId);
}

function bundledSkillPath(repoRoot: string, pluginId: string, ...relativePath: string[]) {
  return path.join(bundledPluginDir(repoRoot, pluginId), ...relativePath);
}

function expectBundledSkills(repoRoot: string, pluginId: string, skills: string[]) {
  expect(readBundledManifest(repoRoot, pluginId).skills).toEqual(skills);
}

function createTlonSkillPlugin(repoRoot: string, skillPath = "node_modules/@tloncorp/tlon-skill") {
  return createPlugin(repoRoot, {
    id: "tlon",
    packageName: "@openclaw/tlon",
    manifest: { skills: [skillPath] },
    packageOpenClaw: { extensions: ["./index.ts"] },
  });
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("rewritePackageExtensions", () => {
  it("rewrites TypeScript extension entries to built JS paths", () => {
    expect(rewritePackageExtensions(["./index.ts", "./nested/entry.mts"])).toEqual([
      "./index.js",
      "./nested/entry.js",
    ]);
  });
});

describe("copyBundledPluginMetadata", () => {
  it("copies plugin manifests, package metadata, and local skill directories", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-meta-");
    const pluginDir = createPlugin(repoRoot, {
      id: "acpx",
      packageName: "@openclaw/acpx",
      manifest: { skills: ["./skills"] },
      packageOpenClaw: { extensions: ["./index.ts"] },
    });
    fs.mkdirSync(path.join(pluginDir, "skills", "acp-router"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "skills", "acp-router", "SKILL.md"),
      "# ACP Router\n",
      "utf8",
    );

    copyBundledPluginMetadata({ repoRoot });

    expect(
      fs.existsSync(path.join(repoRoot, "dist", "extensions", "acpx", "openclaw.plugin.json")),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "acpx", "skills", "acp-router", "SKILL.md"),
        "utf8",
      ),
    ).toContain("ACP Router");
    expectBundledSkills(repoRoot, "acpx", ["./skills"]);
    const packageJson = readBundledPackageJson(repoRoot, "acpx");
    expect(packageJson.openclaw?.extensions).toEqual(["./index.js"]);
  });

  it("relocates node_modules-backed skill paths into bundled-skills and rewrites the manifest", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-node-modules-");
    const pluginDir = createTlonSkillPlugin(repoRoot);
    const storeSkillDir = path.join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "@tloncorp+tlon-skill@0.2.2",
      "node_modules",
      "@tloncorp",
      "tlon-skill",
    );
    fs.mkdirSync(storeSkillDir, { recursive: true });
    fs.writeFileSync(path.join(storeSkillDir, "SKILL.md"), "# Tlon Skill\n", "utf8");
    fs.mkdirSync(path.join(storeSkillDir, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(
      path.join(storeSkillDir, "node_modules", ".bin", "tlon"),
      "#!/bin/sh\n",
      "utf8",
    );
    fs.mkdirSync(path.join(pluginDir, "node_modules", "@tloncorp"), { recursive: true });
    fs.symlinkSync(
      storeSkillDir,
      path.join(pluginDir, "node_modules", "@tloncorp", "tlon-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const staleNodeModulesSkillDir = path.join(
      bundledPluginDir(repoRoot, "tlon"),
      "node_modules",
      "@tloncorp",
      "tlon-skill",
    );
    fs.mkdirSync(staleNodeModulesSkillDir, { recursive: true });
    fs.writeFileSync(path.join(staleNodeModulesSkillDir, "stale.txt"), "stale\n", "utf8");

    copyBundledPluginMetadata({ repoRoot });

    const copiedSkillDir = path.join(
      bundledPluginDir(repoRoot, "tlon"),
      "bundled-skills",
      "@tloncorp",
      "tlon-skill",
    );
    expect(fs.existsSync(path.join(copiedSkillDir, "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(copiedSkillDir).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(copiedSkillDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(bundledPluginDir(repoRoot, "tlon"), "node_modules"))).toBe(
      false,
    );
    expectBundledSkills(repoRoot, "tlon", ["./bundled-skills/@tloncorp/tlon-skill"]);
  });

  it("falls back to repo-root hoisted node_modules skill paths", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-hoisted-skill-");
    const pluginDir = createTlonSkillPlugin(repoRoot);
    const hoistedSkillDir = path.join(repoRoot, "node_modules", "@tloncorp", "tlon-skill");
    fs.mkdirSync(hoistedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(hoistedSkillDir, "SKILL.md"), "# Hoisted Tlon Skill\n", "utf8");
    fs.mkdirSync(pluginDir, { recursive: true });

    copyBundledPluginMetadata({ repoRoot });

    expect(
      fs.readFileSync(
        bundledSkillPath(repoRoot, "tlon", "bundled-skills", "@tloncorp", "tlon-skill", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Hoisted Tlon Skill");
    expectBundledSkills(repoRoot, "tlon", ["./bundled-skills/@tloncorp/tlon-skill"]);
  });

  it("omits missing declared skill paths and removes stale generated outputs", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-missing-skill-");
    createTlonSkillPlugin(repoRoot);
    const staleBundledSkillDir = path.join(
      bundledPluginDir(repoRoot, "tlon"),
      "bundled-skills",
      "@tloncorp",
      "tlon-skill",
    );
    fs.mkdirSync(staleBundledSkillDir, { recursive: true });
    fs.writeFileSync(path.join(staleBundledSkillDir, "SKILL.md"), "# stale\n", "utf8");
    const staleNodeModulesDir = path.join(bundledPluginDir(repoRoot, "tlon"), "node_modules");
    fs.mkdirSync(staleNodeModulesDir, { recursive: true });

    copyBundledPluginMetadata({ repoRoot });

    expectBundledSkills(repoRoot, "tlon", []);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "tlon", "bundled-skills"))).toBe(
      false,
    );
    expect(fs.existsSync(staleNodeModulesDir)).toBe(false);
  });

  it("retries transient skill copy races from concurrent runtime postbuilds", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-retry-");
    const pluginDir = createPlugin(repoRoot, {
      id: "diffs",
      packageName: "@openclaw/diffs",
      manifest: { skills: ["./skills"] },
      packageOpenClaw: { extensions: ["./index.ts"] },
    });
    fs.mkdirSync(path.join(pluginDir, "skills", "diffs"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "skills", "diffs", "SKILL.md"), "# Diffs\n", "utf8");

    const realCpSync = fs.cpSync.bind(fs);
    let attempts = 0;
    const cpSyncSpy = vi.spyOn(fs, "cpSync").mockImplementation((...args) => {
      attempts += 1;
      if (attempts === 1) {
        const error = Object.assign(new Error("race"), { code: "EEXIST" });
        throw error;
      }
      return realCpSync(...args);
    });

    try {
      copyBundledPluginMetadata({ repoRoot });
    } finally {
      cpSyncSpy.mockRestore();
    }

    expect(attempts).toBe(2);
    expect(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "diffs", "skills", "diffs", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Diffs");
  });

  it("removes generated outputs for plugins no longer present in source", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-removed-");
    const staleBundledSkillDir = path.join(
      repoRoot,
      "dist",
      "extensions",
      "removed-plugin",
      "bundled-skills",
      "@scope",
      "skill",
    );
    fs.mkdirSync(staleBundledSkillDir, { recursive: true });
    fs.writeFileSync(path.join(staleBundledSkillDir, "SKILL.md"), "# stale\n", "utf8");
    const staleNodeModulesDir = path.join(
      repoRoot,
      "dist",
      "extensions",
      "removed-plugin",
      "node_modules",
    );
    fs.mkdirSync(staleNodeModulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "dist", "extensions", "removed-plugin", "index.js"),
      "export default {}\n",
      "utf8",
    );
    writeJson(path.join(repoRoot, "dist", "extensions", "removed-plugin", "openclaw.plugin.json"), {
      id: "removed-plugin",
      configSchema: { type: "object" },
      skills: ["./bundled-skills/@scope/skill"],
    });
    writeJson(path.join(repoRoot, "dist", "extensions", "removed-plugin", "package.json"), {
      name: "@openclaw/removed-plugin",
    });
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "removed-plugin"))).toBe(false);
  });

  it("removes stale dist outputs when a source extension directory no longer has a manifest", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-manifestless-source-");
    const sourcePluginDir = path.join(repoRoot, "extensions", "google-gemini-cli-auth");
    fs.mkdirSync(path.join(sourcePluginDir, "node_modules"), { recursive: true });
    const staleDistDir = path.join(repoRoot, "dist", "extensions", "google-gemini-cli-auth");
    fs.mkdirSync(staleDistDir, { recursive: true });
    fs.writeFileSync(path.join(staleDistDir, "index.js"), "export default {}\n", "utf8");
    writeJson(path.join(staleDistDir, "openclaw.plugin.json"), {
      id: "google-gemini-cli-auth",
      configSchema: { type: "object" },
    });
    writeJson(path.join(staleDistDir, "package.json"), {
      name: "@openclaw/google-gemini-cli-auth",
    });

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(staleDistDir)).toBe(false);
  });

  it("removes non-packaged private QA plugin metadata unless private QA build is enabled", () => {
    const repoRoot = makeRepoRoot("openclaw-private-qa-metadata-");
    createPlugin(repoRoot, {
      id: "qa-lab",
      packageName: "@openclaw/qa-lab",
      packageOpenClaw: { extensions: ["./index.ts"] },
    });
    const staleDistDir = path.join(repoRoot, "dist", "extensions", "qa-lab");
    fs.mkdirSync(staleDistDir, { recursive: true });
    fs.writeFileSync(path.join(staleDistDir, "runtime-api.js"), "export {};\n", "utf8");

    copyBundledPluginMetadataWithEnv({ repoRoot, env: {} });

    expect(fs.existsSync(staleDistDir)).toBe(false);

    copyBundledPluginMetadataWithEnv({
      repoRoot,
      env: { OPENCLAW_BUILD_PRIVATE_QA: "1" } as NodeJS.ProcessEnv,
    });

    expect(fs.existsSync(path.join(staleDistDir, "openclaw.plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(staleDistDir, "package.json"))).toBe(true);
  });

  it.each([
    {
      name: "skips metadata for optional bundled clusters only when explicitly disabled",
      pluginId: "acpx",
      packageName: "@openclaw/acpx-plugin",
      packageOpenClaw: { extensions: ["./index.ts"] },
      env: excludeOptionalEnv,
      expectedExists: false,
    },
    {
      name: "still bundles previously released optional plugins without the opt-in env",
      pluginId: "whatsapp",
      packageName: "@openclaw/whatsapp",
      packageOpenClaw: {
        extensions: ["./index.ts"],
        install: { npmSpec: "@openclaw/whatsapp" },
      },
      env: {},
      expectedExists: true,
    },
  ] as const)("$name", ({ pluginId, packageName, packageOpenClaw, env, expectedExists }) => {
    const repoRoot = makeRepoRoot(`openclaw-bundled-plugin-${pluginId}-`);
    createPlugin(repoRoot, {
      id: pluginId,
      packageName,
      packageOpenClaw,
    });

    copyBundledPluginMetadataWithEnv({ repoRoot, env });

    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", pluginId))).toBe(expectedExists);
  });

  it("preserves manifest-less runtime support package outputs and copies package metadata", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-runtime-support-");
    const pluginDir = path.join(repoRoot, "extensions", "image-generation-core");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/image-generation-core",
      version: "0.0.1",
      private: true,
      type: "module",
    });
    fs.writeFileSync(path.join(pluginDir, "runtime-api.ts"), "export {};\n", "utf8");
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions", "image-generation-core"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoRoot, "dist", "extensions", "image-generation-core", "runtime-api.js"),
      "export {};\n",
      "utf8",
    );

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "image-generation-core"))).toBe(
      true,
    );
    expect(
      fs.existsSync(
        path.join(repoRoot, "dist", "extensions", "image-generation-core", "runtime-api.js"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, "dist", "extensions", "image-generation-core", "openclaw.plugin.json"),
      ),
    ).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(repoRoot, "dist", "extensions", "image-generation-core", "package.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      name: "@openclaw/image-generation-core",
      type: "module",
    });
  });
});
