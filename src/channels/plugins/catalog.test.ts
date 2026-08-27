// Channel plugin catalog tests cover plugin catalog entries and metadata normalization.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => []),
);

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

import { getChannelPluginCatalogEntry } from "./catalog.js";

const tempDirs: string[] = [];

beforeEach(() => {
  listChannelCatalogEntriesMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeChannelCatalog(
  catalogPath: string,
  id: string,
  label: string,
  defaultChoice?: string,
): void {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      entries: [
        {
          name: `@example/${id}`,
          openclaw: {
            channel: { id, label, selectionLabel: label, docsPath: `/channels/${id}`, blurb: id },
            install: { npmSpec: `@example/${id}`, ...(defaultChoice ? { defaultChoice } : {}) },
          },
        },
      ],
    }),
  );
}

describe("channel plugin catalog", () => {
  it.each([
    ["omitted", undefined, undefined],
    ["empty", "", ""],
    ["spaced", "  See docs:  ", "  See docs:  "],
  ] as const)("preserves %s selection docs prefixes", (_label, prefix, expected) => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "workspace-chat",
        origin: "workspace",
        rootDir: "/tmp/workspace-chat",
        packageName: "@workspace/chat",
        channel: {
          id: "custom-chat",
          label: "Custom Chat",
          selectionLabel: "Custom Chat",
          docsPath: "/channels/custom-chat",
          blurb: "workspace",
          ...(prefix !== undefined ? { selectionDocsPrefix: prefix } : {}),
        },
        install: { localPath: "/tmp/workspace-chat" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    const entry = getChannelPluginCatalogEntry("custom-chat", {
      workspaceDir: "/tmp",
    });

    expect(entry?.meta.selectionDocsPrefix).toBe(expected);
  });

  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };

    const wecom = getChannelPluginCatalogEntry("wecom", options);
    expect(wecom?.id).toBe("wecom");
    expect(wecom?.pluginId).toBe("wecom-openclaw-plugin");
    expect(wecom?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(wecom?.install?.npmSpec).toBe("@wecom/wecom-openclaw-plugin@2026.7.2");

    const yuanbao = getChannelPluginCatalogEntry("yuanbao", options);
    expect(yuanbao?.id).toBe("yuanbao");
    expect(yuanbao?.pluginId).toBe("openclaw-plugin-yuanbao");
    expect(yuanbao?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(yuanbao?.install?.npmSpec).toBe("openclaw-plugin-yuanbao@2.18.2");
  });

  it("excludes only the rejected origin/plugin pair when resolving fallback copies", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "telegram",
        origin: "config",
        rootDir: "/tmp/config-telegram",
        packageName: "telegram-shadow",
        channel: {
          id: "telegram",
          label: "Telegram Shadow",
          selectionLabel: "Telegram Shadow",
          docsPath: "/channels/telegram",
          blurb: "shadow",
        },
        install: { localPath: "/tmp/config-telegram" },
      },
      {
        pluginId: "telegram",
        origin: "bundled",
        rootDir: "/tmp/bundled-telegram",
        packageName: "@openclaw/telegram",
        channel: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "bundled",
        },
        install: { npmSpec: "@openclaw/telegram@1.0.0" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    expect(
      getChannelPluginCatalogEntry("telegram", {
        excludePluginRefs: [{ pluginId: "telegram", origin: "config" }],
      })?.origin,
    ).toBe("bundled");
  });

  it.each(["__proto__", "constructor", "toString"])(
    "rejects inherited install default choice %s from external catalog input",
    (defaultChoice) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-choice-"));
      tempDirs.push(root);
      const catalogPath = path.join(root, "catalog.json");
      writeChannelCatalog(catalogPath, "unsafe-choice", "Unsafe Choice", defaultChoice);

      const entry = getChannelPluginCatalogEntry("unsafe-choice", {
        catalogPaths: [catalogPath],
        workspaceDir: root,
        env: {},
      });
      expect(entry?.install.defaultChoice).toBe("npm");
    },
  );

  it("reloads external catalog entries after the explicit plugin metadata lifecycle reset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-external-catalog-"));
    tempDirs.push(root);
    const catalogPath = path.join(root, "catalog.json");
    const options = { catalogPaths: [catalogPath], workspaceDir: root, env: {} };

    expect(getChannelPluginCatalogEntry("lifecycle-external", options)).toBeUndefined();
    writeChannelCatalog(catalogPath, "lifecycle-external", "After external install");
    clearPluginMetadataLifecycleCaches();

    expect(getChannelPluginCatalogEntry("lifecycle-external", options)?.meta.label).toBe(
      "After external install",
    );
  });

  it("reloads official generated catalog entries after the explicit plugin metadata lifecycle reset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-official-catalog-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const catalogPath = path.join(root, "dist", "channel-catalog.json");
    const options = { catalogPaths: [path.join(root, "external.json")], env: {} };

    expect(getChannelPluginCatalogEntry("lifecycle-official", options)).toBeUndefined();
    writeChannelCatalog(catalogPath, "lifecycle-official", "After official update");
    clearPluginMetadataLifecycleCaches();

    expect(getChannelPluginCatalogEntry("lifecycle-official", options)?.meta.label).toBe(
      "After official update",
    );
  });
});
