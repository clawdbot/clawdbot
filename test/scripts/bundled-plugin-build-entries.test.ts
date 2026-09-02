// Bundled Plugin Build Entries tests cover bundled plugin build entries script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectChannelConfigDoctorBuildEntries,
  collectPluginDeclarationSourceEntries,
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
  listBundledPluginBuildEntries,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { resolvePluginNpmRuntimeBuildPlan } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectNoPrefixMatches(values: string[], prefix: string) {
  expect(values.filter((value) => value.startsWith(prefix))).toEqual([]);
}

function expectSomePrefixMatch(values: string[], prefix: string) {
  expect(values.filter((value) => value.startsWith(prefix))).not.toEqual([]);
}

function pickEntries(entries: Record<string, string>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, entries[key]]));
}

describe("bundled plugin build entries", () => {
  it("selects typed barrels and manifest exports rather than every runtime sidecar", () => {
    const sources = [
      "./index.ts",
      "./api.ts",
      "./runtime-api.ts",
      "./contract-api.ts",
      "./client.ts",
      "./types.ts",
      "./runtime-helper.ts",
      "./setup-entry.ts",
    ];
    expect(
      collectPluginDeclarationSourceEntries(
        {
          exports: { "./client": { types: "./dist/client.d.ts", import: "./dist/client.js" } },
          types: "./dist/types.d.ts",
        },
        sources,
      ),
    ).toEqual(["./api.ts", "./runtime-api.ts", "./contract-api.ts", "./client.ts", "./types.ts"]);
  });

  it("retains manifest-owned config repairs independently of runtime package exclusions", () => {
    const cwd = tempDirs.make("openclaw-config-doctor-entries-");
    const pluginDir = path.join(cwd, "extensions", "external-owner");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        files: ["dist/**", "!dist/extensions/external-owner/**"],
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/external-owner",
        openclaw: { build: { bundledDist: false } },
      }),
    );
    const manifest = {
      id: "external-owner",
      channels: ["renamed-channel"],
      doctorContract: { configRepair: true, stateMigrations: true },
    };
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => collectChannelConfigDoctorBuildEntries({ cwd })).toThrow(
      /Missing config-only doctor entrypoint/,
    );
    fs.writeFileSync(
      path.join(pluginDir, "config-doctor-api.ts"),
      "export const legacyConfigRules = [];\n",
    );
    expect(collectChannelConfigDoctorBuildEntries({ cwd })).toEqual({
      "renamed-channel": "extensions/external-owner/config-doctor-api.ts",
    });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, doctorContract: { stateMigrations: true } }),
    );
    expect(collectChannelConfigDoctorBuildEntries({ cwd })).toEqual({});
  });

  const bundledChannelEntrySources = ["index.ts", "channel-entry.ts", "setup-entry.ts"];
  const forEachBundledChannelEntry = (
    visit: (params: { entryPath: string; entry: string; pluginId: string }) => void,
  ) => {
    for (const dirent of fs.readdirSync("extensions", { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }

      for (const sourceEntry of bundledChannelEntrySources) {
        const entryPath = path.join("extensions", dirent.name, sourceEntry);
        if (!fs.existsSync(entryPath)) {
          continue;
        }
        visit({
          entryPath,
          entry: fs.readFileSync(entryPath, "utf8"),
          pluginId: dirent.name,
        });
      }
    }
  };

  it("includes the manifest-less runtime core support package in dist build entries", () => {
    const entries = listBundledPluginBuildEntries();
    const expectedEntries = {
      "extensions/image-generation-core/runtime-api":
        "extensions/image-generation-core/runtime-api.ts",
    };

    expect(pickEntries(entries, Object.keys(expectedEntries))).toStrictEqual(expectedEntries);
  });

  it("keeps the Matrix packaged runtime shim in its package-owned build", () => {
    const entries = listBundledPluginBuildEntries();
    const plan = resolvePluginNpmRuntimeBuildPlan({ packageDir: "extensions/matrix" });
    expect(entries["extensions/matrix/plugin-entry.handlers.runtime"]).toBeUndefined();
    expect(plan?.entry["plugin-entry.handlers.runtime"]).toBe(
      path.resolve("extensions/matrix/plugin-entry.handlers.runtime.ts"),
    );
    expect(plan?.runtimeBuildOutputs).toContain("./dist/plugin-entry.handlers.runtime.js");
  });

  it("keeps Codex CLI metadata in bundled build and standalone pack entries", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts({ includeRootPackageExcludedDirs: true });

    expect(entries["extensions/codex/cli-metadata"]).toBe("extensions/codex/cli-metadata.ts");
    expect(artifacts).toContain("dist/extensions/codex/cli-metadata.js");
  });

  it("builds narrow QA runner public surfaces", () => {
    const entries = listBundledPluginBuildEntries();

    expect(entries["extensions/buzz/qa-runner-api"]).toBe("extensions/buzz/qa-runner-api.ts");
    expect(entries["extensions/msteams/qa-runner-api"]).toBe("extensions/msteams/qa-runner-api.ts");
  });

  it("filters bundled plugin build entries for bounded script lanes", () => {
    const entries = listBundledPluginBuildEntries({
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "active-memory,acpx",
      },
    });
    const entryKeys = Object.keys(entries);

    expect(entryKeys).toEqual(expect.arrayContaining(["extensions/acpx/index"]));
    expect(entryKeys.every((entry) => /^extensions\/(?:acpx|active-memory)\//u.test(entry))).toBe(
      true,
    );
  });

  it("rejects unknown bounded bundled plugin build ids", () => {
    expect(() =>
      listBundledPluginBuildEntries({
        env: {
          ...process.env,
          OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "missing-plugin",
        },
      }),
    ).toThrow(
      "OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS references unknown bundled plugin id(s): missing-plugin",
    );
  });

  it("keeps the Telegram ingress worker out of bundled plugin public-surface entries", () => {
    const entries = listBundledPluginBuildEntries();

    expect(entries["extensions/telegram/telegram-ingress-worker.runtime"]).toBeUndefined();
  });

  it("keeps top-level bundled plugin test helpers out of public-surface entries", () => {
    const entries = listBundledPluginBuildEntries();

    expect(entries["extensions/browser/test-support"]).toBeUndefined();
    expect(entries["extensions/comfy/test-helpers"]).toBeUndefined();
    expect(entries["extensions/minimax/provider-http.test-helpers"]).toBeUndefined();
  });

  it("discovers repo plugin build entries without directory scans", () => {
    const payload = expectNoNodeFsScans<{
      artifacts: number;
      entries: number;
    }>(
      `
        const build = await import("./scripts/lib/bundled-plugin-build-entries.mjs");
        const entries = build.listBundledPluginBuildEntries();
        const artifacts = build.listBundledPluginPackArtifacts();
        return {
          artifacts: artifacts.length,
          entries: Object.keys(entries).length,
        };
      `,
      { counters: ["readdirSync"] },
    );

    expect(payload.entries).toBeGreaterThan(0);
    expect(payload.artifacts).toBeGreaterThan(0);
  });

  it("packs the runtime core support package without requiring a plugin manifest", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toContain("dist/extensions/image-generation-core/package.json");
    expect(artifacts).toContain("dist/extensions/image-generation-core/runtime-api.js");
    expect(artifacts).not.toContain("dist/extensions/image-generation-core/openclaw.plugin.json");
  });

  it("leaves Matrix packaging to the standalone package build", () => {
    const artifacts = listBundledPluginPackArtifacts({ includeRootPackageExcludedDirs: true });

    expectNoPrefixMatches(artifacts, "dist/extensions/matrix/");
  });

  it("keeps private QA bundles out of required npm pack artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expectNoPrefixMatches(artifacts, "dist/extensions/qa-channel/");
    expectNoPrefixMatches(artifacts, "dist/extensions/qa-lab/");
  });

  it("keeps explicitly downloadable plugins out of bundled package artifacts", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    for (const pluginId of ["acpx", "googlechat", "line"]) {
      expectSomePrefixMatch(Object.keys(entries), `extensions/${pluginId}/`);
      expectNoPrefixMatches(artifacts, `dist/extensions/${pluginId}/`);
    }
    for (const pluginId of ["whatsapp"]) {
      expectNoPrefixMatches(Object.keys(entries), `extensions/${pluginId}/`);
      expectNoPrefixMatches(artifacts, `dist/extensions/${pluginId}/`);
    }
  });

  it("keeps external-only providers out of bundled dist entries", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    for (const pluginId of ["amazon-bedrock", "amazon-bedrock-mantle", "anthropic-vertex"]) {
      expectNoPrefixMatches(Object.keys(entries), `extensions/${pluginId}/`);
      expectNoPrefixMatches(artifacts, `dist/extensions/${pluginId}/`);
    }
  });

  it("keeps externalized runtime-dependency plugins out of bundled dist entries", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    for (const pluginId of [
      "copilot",
      "diffs",
      "diffs-language-pack",
      "openshell",
      "slack",
      "tokenjuice",
    ]) {
      expectNoPrefixMatches(Object.keys(entries), `extensions/${pluginId}/`);
      expectNoPrefixMatches(artifacts, `dist/extensions/${pluginId}/`);
    }
  });

  it("builds explicitly selected external plugins only for Docker", () => {
    const baselineEnv = { ...process.env };
    delete baselineEnv[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV];
    const dockerEnv = {
      ...baselineEnv,
      [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack clickclack,slack,msteams,whatsapp",
    };
    const entries = listBundledPluginBuildEntries({ env: dockerEnv });
    const baselineArtifacts = listBundledPluginPackArtifacts({ env: baselineEnv });
    const artifacts = listBundledPluginPackArtifacts({ env: dockerEnv });
    const reorderedEntries = listBundledPluginBuildEntries({
      env: {
        ...baselineEnv,
        [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "whatsapp,msteams,clickclack slack",
      },
    });
    const entryKeys = Object.keys(entries);

    expect(entries["extensions/clickclack/index"]).toBe("extensions/clickclack/index.ts");
    expect(entries["extensions/slack/index"]).toBe("extensions/slack/index.ts");
    expect(entries["extensions/slack/setup-entry"]).toBe("extensions/slack/setup-entry.ts");
    expect(entries["extensions/msteams/index"]).toBe("extensions/msteams/index.ts");
    expect(entries["extensions/whatsapp/index"]).toBe("extensions/whatsapp/index.ts");
    expect(entries["extensions/whatsapp/setup-entry"]).toBe("extensions/whatsapp/setup-entry.ts");
    expect(entries["extensions/clawrouter/index"]).toBe("extensions/clawrouter/index.ts");
    expect(entryKeys.findIndex((entry) => entry.startsWith("extensions/clickclack/"))).toBeLessThan(
      entryKeys.findIndex((entry) => entry.startsWith("extensions/slack/")),
    );
    expect(Object.keys(reorderedEntries)).toEqual(entryKeys);
    expect(artifacts).toEqual(baselineArtifacts);
    expectNoPrefixMatches(artifacts, "dist/extensions/clickclack/");
    expectNoPrefixMatches(artifacts, "dist/extensions/msteams/");
    expectNoPrefixMatches(artifacts, "dist/extensions/slack/");
    expectNoPrefixMatches(artifacts, "dist/extensions/whatsapp/");
  });

  it("sorts Docker-selected build entries without git metadata", () => {
    const repoDir = tempDirs.make("openclaw-docker-build-entries-");
    const extensionsDir = path.join(repoDir, "extensions");

    for (const pluginId of ["clickclack", "msteams", "slack"]) {
      const pluginDir = path.join(extensionsDir, pluginId);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {};\n");
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        `${JSON.stringify({ id: pluginId })}\n`,
      );
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        `${JSON.stringify({
          name: `@openclaw/${pluginId}`,
          openclaw: {
            extensions: ["./index.ts"],
            build: { bundledDist: false },
          },
        })}\n`,
      );
    }

    const unsortedDirents = fs.readdirSync(extensionsDir, { withFileTypes: true }).toReversed();
    const readdirSpy = vi
      .spyOn(fs, "readdirSync")
      .mockImplementationOnce(() => unsortedDirents as never);
    try {
      expect(
        Object.keys(
          listBundledPluginBuildEntries({
            cwd: repoDir,
            env: {
              ...process.env,
              [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,msteams,clickclack",
            },
          }),
        ),
      ).toEqual([
        "extensions/clickclack/index",
        "extensions/msteams/index",
        "extensions/slack/index",
      ]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("preserves known package-less bundled Docker plugin selections", () => {
    const baselineEnv = { ...process.env };
    delete baselineEnv[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV];
    const baselineEntries = listBundledPluginBuildEntries({ env: baselineEnv });
    const selectedEntries = listBundledPluginBuildEntries({
      env: {
        ...baselineEnv,
        [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "active-memory",
      },
    });

    expect(selectedEntries).toEqual(baselineEntries);
    expect(selectedEntries["extensions/active-memory/index"]).toBe(
      "extensions/active-memory/index.ts",
    );
  });

  it("rejects unknown and invalid Docker plugin selections", () => {
    for (const [selection, message] of [
      [
        "missing-plugin",
        `${DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV} references unknown plugin id(s): missing-plugin`,
      ],
      [
        "../clickclack",
        `${DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV} contains invalid plugin id(s): ../clickclack`,
      ],
    ] as const) {
      expect(() =>
        listBundledPluginBuildEntries({
          env: {
            ...process.env,
            [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: selection,
          },
        }),
      ).toThrow(message);
    }
  });

  it("excludes externalized model providers from bundled artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    for (const pluginId of [
      "byteplus",
      "cohere",
      "meta",
      "mistral",
      "novita",
      "opencode",
      "xiaomi",
    ]) {
      expect(artifacts).not.toContain(`dist/extensions/${pluginId}/index.js`);
      expect(artifacts).not.toContain(`dist/extensions/${pluginId}/openclaw.plugin.json`);
      expect(artifacts).not.toContain(`dist/extensions/${pluginId}/package.json`);
    }
  });

  it("keeps OpenCode Go bundled until its companion artifact is available", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toEqual(
      expect.arrayContaining([
        "dist/extensions/opencode-go/index.js",
        "dist/extensions/opencode-go/openclaw.plugin.json",
        "dist/extensions/opencode-go/package.json",
      ]),
    );
  });

  it("excludes the externalized Vydra provider from bundled artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).not.toContain("dist/extensions/vydra/index.js");
    expect(artifacts).not.toContain("dist/extensions/vydra/openclaw.plugin.json");
    expect(artifacts).not.toContain("dist/extensions/vydra/package.json");
  });

  it("excludes the externalized ComfyUI provider from bundled artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expectNoPrefixMatches(artifacts, "dist/extensions/comfy/");
  });

  it("excludes externalized meeting plugins from bundled artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    for (const pluginId of ["teams-meetings", "zoom-meetings"]) {
      expect(artifacts).not.toContain(`dist/extensions/${pluginId}/index.js`);
      expect(artifacts).not.toContain(`dist/extensions/${pluginId}/openclaw.plugin.json`);
      expect(artifacts).not.toContain(`dist/extensions/${pluginId}/package.json`);
    }
  });

  it("excludes the externalized Synthetic provider from bundled artifacts", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    expectNoPrefixMatches(Object.keys(entries), "extensions/synthetic/");
    expectNoPrefixMatches(artifacts, "dist/extensions/synthetic/");
  });

  it("excludes the externalized DuckDuckGo plugin from bundled artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).not.toContain("dist/extensions/duckduckgo/index.js");
    expect(artifacts).not.toContain("dist/extensions/duckduckgo/openclaw.plugin.json");
    expect(artifacts).not.toContain("dist/extensions/duckduckgo/package.json");
  });

  it("excludes the externalized Voyage provider from bundled artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).not.toContain("dist/extensions/voyage/index.js");
    expect(artifacts).not.toContain("dist/extensions/voyage/openclaw.plugin.json");
    expect(artifacts).not.toContain("dist/extensions/voyage/package.json");
  });

  it("excludes the externalized Volcengine provider from bundled artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).not.toContain("dist/extensions/volcengine/index.js");
    expect(artifacts).not.toContain("dist/extensions/volcengine/openclaw.plugin.json");
    expect(artifacts).not.toContain("dist/extensions/volcengine/package.json");
  });

  it("excludes the externalized iMessage channel from bundled artifacts", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    expectNoPrefixMatches(Object.keys(entries), "extensions/imessage/");
    expectNoPrefixMatches(artifacts, "dist/extensions/imessage/");
  });

  it("keeps bundled channel secret contracts on packed top-level sidecars", () => {
    const artifacts = listBundledPluginPackArtifacts();
    const excludedPackageDirs = collectRootPackageExcludedExtensionDirs();
    const offenders: string[] = [];
    const secretBackedPluginIds = new Set<string>();

    forEachBundledChannelEntry(({ entryPath, entry, pluginId }) => {
      if (!entry.includes('exportName: "channelSecrets"')) {
        return;
      }
      secretBackedPluginIds.add(pluginId);
      if (entry.includes("./src/secret-contract.js")) {
        offenders.push(entryPath);
      }
      expect(entry).toContain('specifier: "./secret-contract-api.js"');
    });

    expect(offenders).toStrictEqual([]);

    for (const pluginId of [...secretBackedPluginIds].toSorted()) {
      if (excludedPackageDirs.has(pluginId)) {
        continue;
      }
      const secretApiPath = path.join("extensions", pluginId, "secret-contract-api.ts");
      expect(fs.readFileSync(secretApiPath, "utf8")).toContain("channelSecrets");
      expect(artifacts).toContain(`dist/extensions/${pluginId}/secret-contract-api.js`);
    }
  });

  it("keeps dedicated channel contract exports off broad contract-api sidecars", () => {
    const duplicateExportMarkersByArtifact = {
      "directory-contract-api.ts": [
        "DirectoryContractPlugin",
        "DirectoryGroupsFromConfig",
        "DirectoryPeersFromConfig",
      ],
      "doctor-contract-api.ts": [
        "legacyConfigRules",
        "normalizeCompatibilityConfig",
        "stateMigrations",
      ],
      "secret-contract-api.ts": [
        "channelSecrets",
        "collectRuntimeConfigAssignments",
        "secretTargetRegistryEntries",
      ],
      "security-audit-contract-api.ts": ["SecurityAuditFindings"],
      "security-contract-api.ts": [
        "collectUnsupportedSecretRefConfigCandidates",
        "unsupportedSecretRefSurfacePatterns",
      ],
      "session-binding-contract-api.ts": [
        "ConversationBindingManager",
        "ThreadBindingManager",
        "ThreadBindingsForTests",
        "setMatrixRuntime",
      ],
    } as const;
    const offenders: string[] = [];

    for (const dirent of fs.readdirSync("extensions", { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const contractApiPath = path.join("extensions", dirent.name, "contract-api.ts");
      if (!fs.existsSync(contractApiPath)) {
        continue;
      }
      const contractApi = fs.readFileSync(contractApiPath, "utf8");
      for (const [artifact, markers] of Object.entries(duplicateExportMarkersByArtifact)) {
        if (!fs.existsSync(path.join("extensions", dirent.name, artifact))) {
          continue;
        }
        for (const marker of markers) {
          if (contractApi.includes(marker)) {
            offenders.push(`${contractApiPath} duplicates ${artifact}: ${marker}`);
          }
        }
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled channel entry metadata on packed top-level sidecars", () => {
    const offenders: string[] = [];

    forEachBundledChannelEntry(({ entryPath, entry }) => {
      if (
        !entry.includes("defineBundledChannelEntry") &&
        !entry.includes("defineBundledChannelSetupEntry")
      ) {
        return;
      }
      if (/specifier:\s*["']\.\/src\//u.test(entry)) {
        offenders.push(entryPath);
      }
    });

    expect(offenders).toStrictEqual([]);
  });
});
