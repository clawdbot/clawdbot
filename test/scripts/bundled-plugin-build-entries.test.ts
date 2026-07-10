// Bundled Plugin Build Entries tests cover bundled plugin build entries script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
  listBundledPluginBuildEntries,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
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

  it("includes manifest-less runtime core support packages in dist build entries", () => {
    const entries = listBundledPluginBuildEntries();
    const expectedEntries = {
      "extensions/image-generation-core/api": "extensions/image-generation-core/api.ts",
      "extensions/image-generation-core/runtime-api":
        "extensions/image-generation-core/runtime-api.ts",
      "extensions/media-understanding-core/runtime-api":
        "extensions/media-understanding-core/runtime-api.ts",
    };

    expect(pickEntries(entries, Object.keys(expectedEntries))).toStrictEqual(expectedEntries);
  });

  it("keeps the Matrix packaged runtime shim in bundled plugin build entries", () => {
    const entries = listBundledPluginBuildEntries();
    const expectedEntries = {
      "extensions/matrix/plugin-entry.handlers.runtime":
        "extensions/matrix/plugin-entry.handlers.runtime.ts",
    };

    expect(pickEntries(entries, Object.keys(expectedEntries))).toStrictEqual(expectedEntries);
  });

  it("keeps Codex Supervisor CLI metadata in bundled build and pack entries", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    expect(entries["extensions/codex-supervisor/cli-metadata"]).toBe(
      "extensions/codex-supervisor/cli-metadata.ts",
    );
    expect(artifacts).toContain("dist/extensions/codex-supervisor/cli-metadata.js");
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

  it("packs runtime core support packages without requiring plugin manifests", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toContain("dist/extensions/image-generation-core/package.json");
    expect(artifacts).toContain("dist/extensions/image-generation-core/runtime-api.js");
    expect(artifacts).not.toContain("dist/extensions/image-generation-core/openclaw.plugin.json");
    expect(artifacts).toContain("dist/extensions/media-understanding-core/runtime-api.js");
    expect(artifacts).not.toContain(
      "dist/extensions/media-understanding-core/openclaw.plugin.json",
    );
  });

  it("packs the Matrix packaged runtime shim", () => {
    const artifacts = listBundledPluginPackArtifacts({ includeRootPackageExcludedDirs: true });

    expect(artifacts).toContain("dist/extensions/matrix/plugin-entry.handlers.runtime.js");
  });

  it("keeps private QA bundles out of required npm pack artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expectNoPrefixMatches(artifacts, "dist/extensions/qa-channel/");
    expectNoPrefixMatches(artifacts, "dist/extensions/qa-lab/");
    expectNoPrefixMatches(artifacts, "dist/extensions/qa-matrix/");
  });

  it("keeps explicitly downloadable plugins out of bundled package artifacts", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    for (const pluginId of ["acpx", "googlechat", "line"]) {
      expectSomePrefixMatch(Object.keys(entries), `extensions/${pluginId}/`);
      expectNoPrefixMatches(artifacts, `dist/extensions/${pluginId}/`);
    }
    for (const pluginId of ["qqbot", "whatsapp"]) {
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

    for (const pluginId of ["copilot", "openshell", "slack", "tokenjuice"]) {
      expectNoPrefixMatches(Object.keys(entries), `extensions/${pluginId}/`);
      expectNoPrefixMatches(artifacts, `dist/extensions/${pluginId}/`);
    }
  });

  it("builds explicitly selected external plugins only for Docker", () => {
    const baselineEnv = { ...process.env };
    delete baselineEnv[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV];
    const dockerEnv = {
      ...baselineEnv,
      [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack clickclack,slack,msteams",
    };
    const entries = listBundledPluginBuildEntries({ env: dockerEnv });
    const baselineArtifacts = listBundledPluginPackArtifacts({ env: baselineEnv });
    const artifacts = listBundledPluginPackArtifacts({ env: dockerEnv });
    const reorderedEntries = listBundledPluginBuildEntries({
      env: {
        ...baselineEnv,
        [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "msteams,clickclack slack",
      },
    });
    const entryKeys = Object.keys(entries);

    expect(entries["extensions/clickclack/index"]).toBe("extensions/clickclack/index.ts");
    expect(entries["extensions/slack/index"]).toBe("extensions/slack/index.ts");
    expect(entries["extensions/slack/setup-entry"]).toBe("extensions/slack/setup-entry.ts");
    expect(entries["extensions/msteams/index"]).toBe("extensions/msteams/index.ts");
    expect(entries["extensions/clawrouter/index"]).toBe("extensions/clawrouter/index.ts");
    expect(entryKeys.findIndex((entry) => entry.startsWith("extensions/clickclack/"))).toBeLessThan(
      entryKeys.findIndex((entry) => entry.startsWith("extensions/slack/")),
    );
    expect(Object.keys(reorderedEntries)).toEqual(entryKeys);
    expect(artifacts).toEqual(baselineArtifacts);
    expectNoPrefixMatches(artifacts, "dist/extensions/clickclack/");
    expectNoPrefixMatches(artifacts, "dist/extensions/msteams/");
    expectNoPrefixMatches(artifacts, "dist/extensions/slack/");
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

  it("preserves known dependency-only Docker plugin selections", () => {
    const baselineEnv = { ...process.env };
    delete baselineEnv[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV];
    const baselineEntries = listBundledPluginBuildEntries({ env: baselineEnv });
    const selectedEntries = listBundledPluginBuildEntries({
      env: {
        ...baselineEnv,
        [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "whatsapp,qqbot",
      },
    });

    expect(selectedEntries).toEqual(baselineEntries);
    expectNoPrefixMatches(Object.keys(selectedEntries), "extensions/qqbot/");
    expectNoPrefixMatches(Object.keys(selectedEntries), "extensions/whatsapp/");
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

  it("keeps Cohere bundled through the externalization transition", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toContain("dist/extensions/cohere/index.js");
    expect(artifacts).toContain("dist/extensions/cohere/openclaw.plugin.json");
    expect(artifacts).toContain("dist/extensions/cohere/package.json");
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
