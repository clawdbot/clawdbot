import { describe, expect, it } from "vitest";
import { createPluginRecord } from "../../plugins/loader-records.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resolveNodeBootstrapPlugins } from "./node-bootstrap-plugins.js";

function createBootstrapRegistry() {
  const registry = createEmptyPluginRegistry();
  const byPluginId = new Map<string, PluginManifestRecord>();
  const addPlugin = (id: string, options: Partial<PluginManifestRecord> = {}) => {
    const metadata: PluginManifestRecord = {
      id,
      origin: "bundled",
      rootDir: `/source/extensions/${id}`,
      source: `/source/extensions/${id}/index.ts`,
      manifestPath: `/source/extensions/${id}/openclaw.plugin.json`,
      packageName: `@example/${id}`,
      packageVersion: "1.2.3",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      ...options,
    };
    const record = createPluginRecord({ ...metadata, enabled: true, configSchema: true });
    registry.plugins.push(record);
    byPluginId.set(id, metadata);
    return { metadata, record };
  };
  const addHarness = (id: string, commands: string[]) => {
    registry.agentHarnesses.push({
      pluginId: id,
      source: `/source/extensions/${id}/index.ts`,
      harness: {
        id,
        label: id,
        cloudPlacement: {
          mode: "remote-exec",
          devicePlacement: { requiredNodeCommands: commands, consumesWorkerSlot: false },
        },
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("not used");
        },
      },
    });
  };
  const addCommand = (pluginId: string, command: string) => {
    registry.nodeHostCommands.push({
      pluginId,
      source: `/source/extensions/${pluginId}/index.ts`,
      command: { command, handle: async () => "{}" },
    });
  };
  return { registry, metadata: { byPluginId }, addPlugin, addHarness, addCommand };
}

describe("cloud node bootstrap plugins", () => {
  it("packages only the deterministic union of required command owners", () => {
    const fixture = createBootstrapRegistry();
    fixture.addPlugin("harness");
    fixture.addPlugin("native-b", {
      origin: "global",
      trustedOfficialInstall: true,
      rootDir: "/installed/node_modules/@example/native-b",
    });
    fixture.addPlugin("native-a");
    fixture.addPlugin("unrelated");
    fixture.addHarness("harness", ["native.b", "native.a", "native.b"]);
    fixture.addHarness("native-a", ["native.a"]);
    fixture.addCommand("native-a", "native.a");
    fixture.addCommand("native-b", "native.b");
    fixture.addCommand("unrelated", "unrelated.command");

    expect(resolveNodeBootstrapPlugins({ ...fixture, executionMode: "remote-exec" })).toEqual([
      { id: "native-a", root: "/source/extensions/native-a" },
      { id: "native-b", root: "/installed/node_modules/@example/native-b" },
    ]);
    expect(resolveNodeBootstrapPlugins({ ...fixture, executionMode: "worker-turn" })).toEqual([]);
  });

  it("ignores unavailable harnesses instead of installing their command dependencies", () => {
    const fixture = createBootstrapRegistry();
    const { record } = fixture.addPlugin("disabled-harness");
    record.enabled = false;
    record.status = "disabled";
    fixture.addHarness("disabled-harness", ["missing.command"]);

    expect(resolveNodeBootstrapPlugins({ ...fixture, executionMode: "remote-exec" })).toEqual([]);
  });

  it.each([
    "missing-command",
    "disabled-owner",
    "untrusted-owner",
    "changed-root",
    "changed-version",
  ])("rejects %s before packaging a runtime", (failure) => {
    const fixture = createBootstrapRegistry();
    fixture.addPlugin("harness");
    const { metadata, record } = fixture.addPlugin("native");
    fixture.addHarness("harness", ["native.exec"]);
    if (failure !== "missing-command") {
      fixture.addCommand("native", "native.exec");
    }
    if (failure === "disabled-owner") {
      record.enabled = false;
    } else if (failure === "untrusted-owner") {
      metadata.origin = "global";
    } else if (failure === "changed-root") {
      metadata.rootDir = "/replacement/native";
    } else if (failure === "changed-version") {
      metadata.packageVersion = "1.2.4";
    }

    expect(() => resolveNodeBootstrapPlugins({ ...fixture, executionMode: "remote-exec" })).toThrow(
      /Cloud node bootstrap requires/,
    );
  });
});
