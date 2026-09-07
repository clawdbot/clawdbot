import { describe, expect, it } from "vitest";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { i18n, t } from "../../i18n/index.ts";
import { resolveToolProfileOptions, resolveToolSections } from "./tool-catalog.ts";

const TOOLS_CATALOG_RESULT: ToolsCatalogResult = {
  agentId: "main",
  profiles: [
    { id: "minimal", label: "Minimal" },
    { id: "full", label: "Full" },
  ],
  groups: [
    {
      id: "fs",
      label: "Files",
      source: "core",
      tools: [
        {
          id: "read",
          label: "read",
          description: "Read file contents",
          source: "core",
          defaultProfiles: ["coding"],
        },
      ],
    },
    {
      id: "runtime",
      label: "Runtime",
      source: "core",
      tools: [
        {
          id: "exec",
          label: "exec",
          description: "Run shell commands",
          source: "core",
          defaultProfiles: ["coding"],
        },
      ],
    },
    {
      id: "plugin:my-plugin",
      label: "My Plugin",
      source: "plugin",
      pluginId: "my-plugin",
      tools: [
        {
          id: "my_tool",
          label: "my_tool",
          description: "Plugin tool",
          source: "plugin",
          pluginId: "my-plugin",
          defaultProfiles: [],
        },
      ],
    },
  ],
};

describe("resolveToolSections", () => {
  it("derives fallback labels and descriptions from canonical tool ids", () => {
    const sections = resolveToolSections(null);
    const tools = sections.flatMap((section) => section.tools);

    expect(tools.find((tool) => tool.id === "apply_patch")).toEqual({
      id: "apply_patch",
      label: "apply_patch",
      description: t("agents.toolCatalog.descriptions.applyPatch"),
    });
    expect(tools.find((tool) => tool.id === "view_image")).toEqual({
      id: "view_image",
      label: "view_image",
      description: t("agents.toolCatalog.descriptions.image"),
    });
  });

  it("keeps English core group labels identical to the gateway catalog", () => {
    const sections = resolveToolSections(TOOLS_CATALOG_RESULT);
    expect(sections.map((section) => section.label)).toEqual(["Files", "Runtime", "My Plugin"]);
  });

  // Regression: gateway catalog labels are English-only, so localized UIs
  // rendered "Files"/"Runtime" section names even though translations exist.
  it("translates known core group labels in non-English locales", async () => {
    await i18n.setLocale("zh-CN");
    try {
      const sections = resolveToolSections(TOOLS_CATALOG_RESULT);
      expect(sections.map((section) => section.label)).toEqual([
        t("agents.toolCatalog.groups.files"),
        t("agents.toolCatalog.groups.runtime"),
        "My Plugin",
      ]);
      expect(sections[0]?.label).not.toBe("Files");
      expect(sections[1]?.label).not.toBe("Runtime");
    } finally {
      await i18n.setLocale("en");
    }
  });

  it("keeps catalog tool wiring intact while translating group labels", async () => {
    await i18n.setLocale("zh-CN");
    try {
      const sections = resolveToolSections(TOOLS_CATALOG_RESULT);
      expect(sections[0]?.id).toBe("fs");
      expect(sections[0]?.source).toBe("core");
      expect(sections[0]?.tools).toEqual([
        {
          id: "read",
          label: "read",
          description: "Read file contents",
          source: "core",
          pluginId: undefined,
          optional: undefined,
          defaultProfiles: ["coding"],
        },
      ]);
      expect(sections[2]?.pluginId).toBe("my-plugin");
    } finally {
      await i18n.setLocale("en");
    }
  });
});

describe("resolveToolProfileOptions", () => {
  it("keeps English profile labels identical to the gateway catalog", () => {
    const profiles = resolveToolProfileOptions(TOOLS_CATALOG_RESULT);
    expect(profiles.map((profile) => profile.label)).toEqual(["Minimal", "Full"]);
  });

  it("translates known profile labels in non-English locales", async () => {
    await i18n.setLocale("zh-CN");
    try {
      const profiles = resolveToolProfileOptions(TOOLS_CATALOG_RESULT);
      expect(profiles.map((profile) => profile.label)).toEqual([
        t("agents.toolCatalog.profiles.minimal"),
        t("agents.toolCatalog.profiles.full"),
      ]);
      expect(profiles[0]?.label).not.toBe("Minimal");
    } finally {
      await i18n.setLocale("en");
    }
  });
});
