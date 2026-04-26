import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldExpectNativeJitiForJavaScriptTestRuntime } from "../test-utils/jiti-runtime.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

let clearPluginDoctorContractRegistryCache: typeof import("./doctor-contract-registry.js").clearPluginDoctorContractRegistryCache;
let collectRelevantDoctorPluginIdsForTouchedPaths: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIdsForTouchedPaths;
let listPluginDoctorLegacyConfigRules: typeof import("./doctor-contract-registry.js").listPluginDoctorLegacyConfigRules;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry getJiti", () => {
  beforeEach(async () => {
    resetRegistryJitiMocks();
    vi.resetModules();
    ({
      clearPluginDoctorContractRegistryCache,
      collectRelevantDoctorPluginIdsForTouchedPaths,
      listPluginDoctorLegacyConfigRules,
    } = await import("./doctor-contract-registry.js"));
    clearPluginDoctorContractRegistryCache();
  });

  it("uses the runtime-supported Jiti boundary on Windows for contract-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "contract-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedTryNative = shouldExpectNativeJitiForJavaScriptTestRuntime();

    try {
      listPluginDoctorLegacyConfigRules({
        workspaceDir: pluginRoot,
        env: {},
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(pluginRoot, "contract-api.js"));
    expect(mocks.createJiti.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tryNative: expectedTryNative,
      }),
    );
  });

  it("prefers doctor-contract-api over the broader contract-api surface", () => {
    const pluginRoot = makeTempDir();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'doctor'], message: 'doctor contract' }] };\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'broad'], message: 'broad contract' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    try {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "doctor"],
          message: "doctor contract",
        },
      ]);
      expect(mocks.createJiti).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("uses native require for compatible JavaScript contract modules", () => {
    const pluginRoot = makeTempDir();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'legacy'], message: 'legacy demo key' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    try {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "legacy"],
          message: "legacy demo key",
        },
      ]);
      expect(mocks.createJiti).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("narrows touched-path doctor ids for scoped dry-run validation", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
          talk: {
            voiceId: "legacy-voice",
          },
        },
        touchedPaths: [
          ["channels", "discord", "token"],
          ["plugins", "entries", "memory-wiki", "enabled"],
          ["talk", "voiceId"],
        ],
      }),
    ).toEqual(["discord", "elevenlabs", "memory-wiki"]);
  });

  it("falls back to the full doctor-id set when touched paths are too broad", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
        },
        touchedPaths: [["channels"]],
      }),
    ).toEqual(["discord", "memory-wiki", "telegram"]);
  });
});
