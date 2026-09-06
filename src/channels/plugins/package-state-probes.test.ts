// Package state probe tests cover channel plugin package install and runtime status probes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";
import {
  collectBundledChannelPackageStateLoadFailures,
  hasBundledChannelPackageState,
  hasChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

const listChannelCatalogEntriesMock = vi.hoisted(() => vi.fn());
const isBundledSourceOverlayPathMock = vi.hoisted(() =>
  vi.fn((_params: { sourcePath: string }) => false),
);
const probeLogWarnMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));
vi.mock("../../plugins/bundled-source-overlays.js", () => ({
  isBundledSourceOverlayPath: isBundledSourceOverlayPathMock,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: probeLogWarnMock,
    }),
  };
});

function makeBundledChannelCatalogEntry(params: {
  pluginId: string;
  channelId: string;
}): PluginChannelCatalogEntry {
  return {
    pluginId: params.pluginId,
    origin: "bundled",
    rootDir: "/tmp/openclaw-channel-plugin",
    channel: {
      id: params.channelId,
      configuredState: {
        env: {
          allOf: ["ALIAS_CHAT_TOKEN"],
        },
      },
    },
  };
}

function removeTempDirs() {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  removeTempDirs();
  listChannelCatalogEntriesMock.mockReset();
  isBundledSourceOverlayPathMock.mockReset();
  isBundledSourceOverlayPathMock.mockReturnValue(false);
  probeLogWarnMock.mockReset();
});

afterEach(() => {
  removeTempDirs();
});

describe("channel package-state probes", () => {
  it("uses channel ids when manifest plugin ids differ", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      makeBundledChannelCatalogEntry({
        pluginId: "vendor-alias-chat-plugin",
        channelId: "alias-chat",
      }),
    ]);

    expect(listBundledChannelIdsForPackageState("configuredState")).toEqual(["alias-chat"]);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "alias-chat",
        cfg: {},
        env: { ALIAS_CHAT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "vendor-alias-chat-plugin",
        cfg: {},
        env: { ALIAS_CHAT_TOKEN: "token" },
      }),
    ).toBe(false);
  });

  it("uses manifest env metadata without loading a configured-state module", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        ...makeBundledChannelCatalogEntry({
          pluginId: "env-chat",
          channelId: "env-chat",
        }),
        channel: {
          id: "env-chat",
          configuredState: {
            env: { allOf: ["ENV_CHAT_TOKEN"] },
          },
        },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "env-chat",
        cfg: {},
        env: { ENV_CHAT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "env-chat",
        cfg: {},
        env: { ENV_CHAT_TOKEN: " " },
      }),
    ).toBe(false);
  });

  it.each([
    { name: "PATH", env: { PATH: "/usr/bin" }, configured: false },
    { name: "mixed_case_token", env: { MIXED_CASE_TOKEN: "token" }, configured: true },
  ])("applies the safe channel env-trigger contract to $name", ({ name, env, configured }) => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        ...makeBundledChannelCatalogEntry({ pluginId: "env-chat", channelId: "env-chat" }),
        channel: { id: "env-chat", configuredState: { env: { allOf: [name] } } },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "env-chat",
        cfg: {},
        env,
      }),
    ).toBe(configured);
  });

  it.each([
    { location: "inside", specifier: "./checker.ts", allowed: true },
    { location: "outside", specifier: "../checker.ts", allowed: false },
  ])("keeps TypeScript state probes inside their plugin root ($location)", (fixture) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-probe-"));
    tempDirs.push(root);
    const pluginRoot = path.join(root, "plugin");
    const marker = path.join(root, "evaluated");
    fs.mkdirSync(pluginRoot);
    fs.writeFileSync(
      path.resolve(pluginRoot, fixture.specifier),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "evaluated");`,
        "export function isConfigured(): boolean { return true; }",
      ].join("\n"),
    );
    const configured = hasChannelPackageState({
      entry: {
        pluginId: "source-chat",
        origin: "global",
        rootDir: pluginRoot,
        channel: {
          id: "source-chat",
          configuredState: { specifier: fixture.specifier, exportName: "isConfigured" },
        },
      },
      metadataKey: "configuredState",
      cfg: {},
    });

    expect({ configured, evaluated: fs.existsSync(marker) }).toEqual({
      configured: fixture.allowed,
      evaluated: fixture.allowed,
    });
  });

  it("prefers built bundled package-state probes when the catalog root is source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-probe-"));
    tempDirs.push(root);
    const sourceRoot = path.join(root, "extensions", "matrix");
    const builtRoot = path.join(root, "dist", "extensions", "matrix");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "auth-presence.ts"),
      "throw new Error('source probe should not load');\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(builtRoot, "auth-presence.js"),
      "module.exports.hasAnyMatrixAuth = () => true;\n",
      "utf8",
    );

    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "matrix",
        origin: "bundled",
        rootDir: sourceRoot,
        channel: {
          id: "matrix",
          persistedAuthState: {
            specifier: "./auth-presence",
            exportName: "hasAnyMatrixAuth",
          },
        },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(
      hasBundledChannelPackageState({
        metadataKey: "persistedAuthState",
        channelId: "matrix",
        cfg: {},
      }),
    ).toBe(true);
  });

  it("falls back to source package-state probes when built artifacts are stale", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-fallback-"));
    tempDirs.push(root);
    const sourceRoot = path.join(root, "extensions", "whatsapp");
    const builtRoot = path.join(root, "dist", "extensions", "whatsapp");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "auth-presence.js"),
      "module.exports.hasAnyWhatsAppAuth = () => true;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(builtRoot, "auth-presence.js"),
      "module.exports.stale = () => false;\n",
      "utf8",
    );

    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "whatsapp",
        origin: "bundled",
        rootDir: sourceRoot,
        channel: {
          id: "whatsapp",
          persistedAuthState: {
            specifier: "./auth-presence",
            exportName: "hasAnyWhatsAppAuth",
          },
        },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(
      hasBundledChannelPackageState({
        metadataKey: "persistedAuthState",
        channelId: "whatsapp",
        cfg: {},
      }),
    ).toBe(true);
  });

  it.each(["js", "mtsx", "ctsx"])(
    "preserves %s source overlay precedence over packaged package-state probes",
    (extension) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-overlay-"));
      tempDirs.push(root);
      const sourceRoot = path.join(root, "extensions", "matrix");
      const builtRoot = path.join(root, "dist", "extensions", "matrix");
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.mkdirSync(builtRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, `auth-presence.${extension}`),
        extension === "js"
          ? "module.exports.hasAnyMatrixAuth = () => true;\n"
          : "export const hasAnyMatrixAuth = (): boolean => true;\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(builtRoot, "auth-presence.js"),
        "module.exports.hasAnyMatrixAuth = () => false;\n",
        "utf8",
      );
      isBundledSourceOverlayPathMock.mockImplementation(
        ({ sourcePath }: { sourcePath: string }) => path.resolve(sourcePath) === sourceRoot,
      );

      listChannelCatalogEntriesMock.mockReturnValue([
        {
          pluginId: "matrix",
          origin: "bundled",
          rootDir: sourceRoot,
          channel: {
            id: "matrix",
            configuredState: {
              specifier: `./auth-presence.${extension}`,
              exportName: "hasAnyMatrixAuth",
            },
            persistedAuthState: {
              specifier: `./auth-presence.${extension}`,
              exportName: "hasAnyMatrixAuth",
            },
          },
        } satisfies PluginChannelCatalogEntry,
      ]);

      for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
        expect(hasBundledChannelPackageState({ metadataKey, channelId: "matrix", cfg: {} })).toBe(
          true,
        );
      }
    },
  );

  it("preserves parent-mounted source overlay precedence over packaged package-state probes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-parent-overlay-"));
    tempDirs.push(root);
    const extensionsRoot = path.join(root, "extensions");
    const sourceRoot = path.join(extensionsRoot, "matrix");
    const builtRoot = path.join(root, "dist", "extensions", "matrix");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "auth-presence.js"),
      "module.exports.hasAnyMatrixAuth = () => true;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(builtRoot, "auth-presence.js"),
      "module.exports.hasAnyMatrixAuth = () => false;\n",
      "utf8",
    );
    isBundledSourceOverlayPathMock.mockImplementation(
      ({ sourcePath }: { sourcePath: string }) => path.resolve(sourcePath) === extensionsRoot,
    );

    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "matrix",
        origin: "bundled",
        rootDir: sourceRoot,
        channel: {
          id: "matrix",
          persistedAuthState: {
            specifier: "./auth-presence",
            exportName: "hasAnyMatrixAuth",
          },
        },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(
      hasBundledChannelPackageState({
        metadataKey: "persistedAuthState",
        channelId: "matrix",
        cfg: {},
      }),
    ).toBe(true);
  });

  it("reports a missing built package-state artifact as not found, not a boundary escape", () => {
    // Reproduces a rebuild window: the catalog root is the built plugin dir while
    // `dist/extensions/<id>` has not been re-emitted yet.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-missing-"));
    tempDirs.push(root);
    const builtRoot = path.join(root, "dist", "extensions", "matrix");
    fs.mkdirSync(builtRoot, { recursive: true });

    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "matrix",
        origin: "bundled",
        rootDir: builtRoot,
        channel: {
          id: "matrix",
          persistedAuthState: {
            specifier: "./auth-presence",
            exportName: "hasAnyMatrixAuth",
          },
        },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(
      hasBundledChannelPackageState({
        metadataKey: "persistedAuthState",
        channelId: "matrix",
        cfg: {},
      }),
    ).toBe(false);
    const warning = String(probeLogWarnMock.mock.calls.at(0)?.[0] ?? "");
    expect(warning).toContain("failed to load persistedAuthState checker for matrix");
    expect(warning).toContain(`plugin module path not found: ${builtRoot}`);
    expect(warning).not.toContain("escapes plugin root");
    expect(collectBundledChannelPackageStateLoadFailures()).toEqual([
      {
        detail: expect.stringContaining(`plugin module path not found: ${builtRoot}`),
        metadataKey: "persistedAuthState",
        pluginId: "matrix",
      },
    ]);
  });

  it("tries dist-runtime package-state probes before falling back to source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-runtime-"));
    tempDirs.push(root);
    const sourceRoot = path.join(root, "extensions", "matrix");
    const builtRoot = path.join(root, "dist", "extensions", "matrix");
    const runtimeRoot = path.join(root, "dist-runtime", "extensions", "matrix");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "auth-presence.js"),
      "throw new Error('source probe should not load');\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(builtRoot, "auth-presence.js"),
      "module.exports.stale = () => false;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimeRoot, "auth-presence.js"),
      "module.exports.hasAnyMatrixAuth = () => true;\n",
      "utf8",
    );

    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "matrix",
        origin: "bundled",
        rootDir: sourceRoot,
        channel: {
          id: "matrix",
          persistedAuthState: {
            specifier: "./auth-presence",
            exportName: "hasAnyMatrixAuth",
          },
        },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(
      hasBundledChannelPackageState({
        metadataKey: "persistedAuthState",
        channelId: "matrix",
        cfg: {},
      }),
    ).toBe(true);
  });
});
