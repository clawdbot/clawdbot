// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { pathForRoute } from "../../app-route-paths.ts";
import { i18n, t } from "../../i18n/index.ts";
import {
  AI_AGENTS_SECTION_KEYS,
  APPEARANCE_SECTION_KEYS,
  AUTOMATION_SECTION_KEYS,
  COMMUNICATION_SECTION_KEYS,
  configPageForSection,
  configSectionKeysForPage,
  INFRASTRUCTURE_SECTION_KEYS,
  MCP_SECTION_KEYS,
  MEMORY_SECTION_KEYS,
  SCOPED_CONFIG_SECTION_KEYS,
  SECURITY_SECTION_KEYS,
  type ConfigPageId,
} from "./config-sections.ts";
import { SETTINGS_SEARCH_TARGETS, type SettingsSearchTarget } from "./settings-targets.ts";

afterEach(async () => {
  await i18n.setLocale("en");
});

describe("settings search target manifest", () => {
  const targets: readonly SettingsSearchTarget[] = Object.values(SETTINGS_SEARCH_TARGETS);

  it("preserves the ordered, canonical paths, sections, and bookmark hashes", () => {
    expect(
      Object.entries(SETTINGS_SEARCH_TARGETS).map(([name, target]) => [
        name,
        pathForRoute(target.routeId),
        "search" in target ? target.search : "",
        target.hash,
      ]),
    ).toEqual([
      ["channels", "/settings/channels", "", ""],
      ["security", "/settings/security", "", ""],
      ["system", "/settings/connection", "", "#settings-connection-host"],
      ["personal", "/settings/profile", "", "#settings-profile-identity"],
      ["modelBehavior", "/settings/model-providers", "", "#settings-model-behavior"],
      [
        "appearanceTheme",
        "/settings/appearance",
        "?section=__appearance__",
        "#settings-appearance-theme",
      ],
      [
        "appearanceTextSize",
        "/settings/appearance",
        "?section=__appearance__",
        "#settings-appearance-text-size",
      ],
      [
        "appearanceSidebar",
        "/settings/appearance",
        "?section=__appearance__",
        "#settings-appearance-sidebar",
      ],
      [
        "appearanceChat",
        "/settings/appearance",
        "?section=__appearance__",
        "#settings-appearance-chat",
      ],
      [
        "appearanceConnection",
        "/settings/appearance",
        "?section=__appearance__",
        "#settings-appearance-connection",
      ],
      ["notifications", "/settings/notifications", "", "#settings-communications-notifications"],
      ["usage", "/usage", "", ""],
      ["sessions", "/sessions", "", ""],
      ["worktrees", "/worktrees", "", ""],
    ]);
  });

  it("assigns every destination exactly once", () => {
    const destinations = targets.map(
      (target) => `${target.routeId}\u0000${target.search ?? ""}\u0000${target.hash}`,
    );

    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it("indexes only translation keys present in the English source catalog", () => {
    for (const target of targets) {
      for (const key of [target.labelKey, ...target.searchKeys]) {
        expect(t(key), `Missing settings search translation: ${key}`).not.toBe(key);
      }
    }
  });

  it("keeps translations in metadata until the active locale resolves them", async () => {
    const modelLabel = t(SETTINGS_SEARCH_TARGETS.modelBehavior.labelKey);

    await i18n.setLocale("es");

    expect(t(SETTINGS_SEARCH_TARGETS.modelBehavior.labelKey)).not.toBe(modelLabel);
    expect(SETTINGS_SEARCH_TARGETS.modelBehavior.labelKey).toBe("quickSettings.model.title");
  });

  it("marks only the identity-dependent target unavailable before connection", () => {
    expect(targets.filter((target) => target.requiresIdentity)).toEqual([
      SETTINGS_SEARCH_TARGETS.personal,
    ]);
  });
});

describe("settings config section ownership", () => {
  const pages: ReadonlyArray<readonly [ConfigPageId, readonly string[]]> = [
    ["communications", COMMUNICATION_SECTION_KEYS],
    ["appearance", APPEARANCE_SECTION_KEYS],
    ["notifications", ["__notifications__"]],
    ["security", SECURITY_SECTION_KEYS],
    ["automation", AUTOMATION_SECTION_KEYS],
    ["mcp", MCP_SECTION_KEYS],
    ["memory", MEMORY_SECTION_KEYS],
    ["infrastructure", INFRASTRUCTURE_SECTION_KEYS],
    ["ai-agents", AI_AGENTS_SECTION_KEYS],
  ];

  it.each(pages)("routes every %s section back to its rendering page", (pageId, sections) => {
    expect(configSectionKeysForPage(pageId)).toEqual(sections);

    for (const section of sections) {
      expect(configPageForSection(section)).toBe(pageId);
    }
  });

  it("assigns each curated section to exactly one page", () => {
    const sections = pages.flatMap(([, pageSections]) => [...pageSections]);

    expect(new Set(sections).size).toBe(sections.length);
    expect([...SCOPED_CONFIG_SECTION_KEYS].toSorted()).toEqual(sections.toSorted());
  });

  it("keeps uncurated sections on Advanced", () => {
    expect(configPageForSection("secrets")).toBe("advanced");
    expect(configPageForSection("broadcast")).toBe("advanced");
    expect(configPageForSection("models")).toBe("advanced");
  });

  it("keeps General and Advanced free of curated include lists", () => {
    expect(configSectionKeysForPage("config")).toBeUndefined();
    expect(configSectionKeysForPage("advanced")).toBeUndefined();
  });
});
