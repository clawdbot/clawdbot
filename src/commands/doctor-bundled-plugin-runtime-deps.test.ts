import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanBundledPluginRuntimeDeps } from "../plugins/bundled-runtime-deps.js";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBundledChannelPlugin(root: string, id: string, dependencies: Record<string, string>) {
  writeJson(path.join(root, "dist", "extensions", id, "package.json"), {
    dependencies,
  });
  writeJson(path.join(root, "dist", "extensions", id, "openclaw.plugin.json"), {
    id,
    channels: [id],
    configSchema: { type: "object" },
  });
}

describe("doctor bundled plugin runtime deps", () => {
  it("skips source checkouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "extensions"));
    writeJson(path.join(root, "dist", "extensions", "discord", "package.json"), {
      dependencies: {
        "dep-one": "1.0.0",
      },
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports missing deps and conflicts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeJson(path.join(root, "dist", "extensions", "alpha", "package.json"), {
      dependencies: {
        "@openclaw/plugin-sdk": "workspace:*",
        "dep-one": "1.0.0",
        "@scope/dep-two": "2.0.0",
        openclaw: "workspace:*",
      },
      optionalDependencies: {
        "dep-opt": "3.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "beta", "package.json"), {
      dependencies: {
        "dep-one": "1.0.0",
        "dep-conflict": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "gamma", "package.json"), {
      dependencies: {
        "dep-conflict": "2.0.0",
      },
    });

    writeJson(path.join(root, "node_modules", "dep-one", "package.json"), {
      name: "dep-one",
      version: "1.0.0",
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    const missing = result.missing.map((dep) => `${dep.name}@${dep.version}`);

    expect(missing).toEqual(["@scope/dep-two@2.0.0", "dep-opt@3.0.0"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.name).toBe("dep-conflict");
    expect(result.conflicts[0]?.versions).toEqual(["1.0.0", "2.0.0"]);
  });

  it("limits configured scans to enabled bundled channel plugins", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeBundledChannelPlugin(root, "discord", { "discord-only": "1.0.0" });
    writeBundledChannelPlugin(root, "whatsapp", { "whatsapp-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: {
          discord: { enabled: true },
        },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "discord-only@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not report bundled channel deps when the channel is not enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "discord", { "discord-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true },
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports default-enabled bundled plugin deps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeJson(path.join(root, "dist", "extensions", "openai", "package.json"), {
      dependencies: {
        "openai-only": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "openai", "openclaw.plugin.json"), {
      id: "openai",
      enabledByDefault: true,
      configSchema: { type: "object" },
    });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "openai-only@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });
});
