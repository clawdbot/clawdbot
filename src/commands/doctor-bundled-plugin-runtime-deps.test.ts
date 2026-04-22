import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveBundledRuntimeDependencyPackageInstallRoot,
  scanBundledPluginRuntimeDeps,
} from "../plugins/bundled-runtime-deps.js";
import { maybeRepairBundledPluginRuntimeDeps } from "./doctor-bundled-plugin-runtime-deps.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

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

  it("can include disabled but configured bundled channel deps for doctor recovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { "telegram-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true },
        channels: {
          telegram: { enabled: false, botToken: "123:abc" },
        },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "telegram-only@1.0.0",
    ]);
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

  it("repairs missing deps during non-interactive doctor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });
    const installed: Array<{
      installRoot: string;
      missingSpecs: string[];
      installSpecs: string[];
    }> = [];
    const prompter = {
      shouldRepair: false,
      shouldForce: false,
      repairMode: {
        shouldRepair: false,
        shouldForce: false,
        nonInteractive: true,
        canPrompt: false,
        updateInProgress: false,
      },
      confirm: async () => false,
      confirmAutoFix: async () => false,
      confirmAggressiveAutoFix: async () => false,
      confirmRuntimeRepair: async () => false,
      select: async (_params: unknown, fallback: unknown) => fallback,
    } as DoctorPrompter;

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: { error: () => {} } as never,
      prompter,
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { telegram: { enabled: true } },
      },
      installDeps: (params) => {
        installed.push(params);
      },
    });

    expect(installed).toEqual([
      {
        installRoot: root,
        missingSpecs: ["grammy@1.37.0"],
        installSpecs: ["grammy@1.37.0"],
      },
    ]);
  });

  it("repairs missing deps into an external stage dir when configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-stage-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw", version: "2026.4.22" });
    writeBundledChannelPlugin(root, "slack", { "@slack/web-api": "7.15.1" });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installed: Array<{
      installRoot: string;
      missingSpecs: string[];
      installSpecs: string[];
    }> = [];
    const prompter = {
      shouldRepair: false,
      shouldForce: false,
      repairMode: {
        shouldRepair: false,
        shouldForce: false,
        nonInteractive: true,
        canPrompt: false,
        updateInProgress: false,
      },
      confirm: async () => false,
      confirmAutoFix: async () => false,
      confirmAggressiveAutoFix: async () => false,
      confirmRuntimeRepair: async () => false,
      select: async (_params: unknown, fallback: unknown) => fallback,
    } as DoctorPrompter;

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: { error: () => {} } as never,
      prompter,
      env,
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { slack: { enabled: true } },
      },
      installDeps: (params) => {
        installed.push(params);
      },
    });

    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(root, { env });
    expect(installed).toEqual([
      {
        installRoot,
        missingSpecs: ["@slack/web-api@7.15.1"],
        installSpecs: ["@slack/web-api@7.15.1"],
      },
    ]);
    expect(installRoot).toContain(stageDir);
  });

  it("retains configured bundled deps when repairing a subset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });
    writeBundledChannelPlugin(root, "slack", { "@slack/web-api": "7.15.1" });
    writeJson(path.join(root, "node_modules", "@slack", "web-api", "package.json"), {
      name: "@slack/web-api",
      version: "7.15.1",
    });
    const installed: Array<{
      installRoot: string;
      missingSpecs: string[];
      installSpecs: string[];
    }> = [];
    const prompter = {
      shouldRepair: false,
      shouldForce: false,
      repairMode: {
        shouldRepair: false,
        shouldForce: false,
        nonInteractive: true,
        canPrompt: false,
        updateInProgress: false,
      },
      confirm: async () => false,
      confirmAutoFix: async () => false,
      confirmAggressiveAutoFix: async () => false,
      confirmRuntimeRepair: async () => false,
      select: async (_params: unknown, fallback: unknown) => fallback,
    } as DoctorPrompter;

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: { error: () => {} } as never,
      prompter,
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true },
        channels: {
          telegram: { enabled: true },
          slack: { enabled: false, botToken: "xoxb-test", appToken: "xapp-test" },
        },
      },
      installDeps: (params) => {
        installed.push(params);
      },
    });

    expect(installed).toEqual([
      {
        installRoot: root,
        missingSpecs: ["grammy@1.37.0"],
        installSpecs: ["@slack/web-api@7.15.1", "grammy@1.37.0"],
      },
    ]);
  });
});
