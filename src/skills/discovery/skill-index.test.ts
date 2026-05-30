import { describe, expect, it } from "vitest";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import {
  buildSkillIndex,
  buildSkillIndexEntries,
  filterPromptVisibleSkillEntries,
  filterUserInvocableSkillEntries,
  isSkillPromptVisible,
  isSkillRuntimeVisible,
  isSkillUserInvocable,
  normalizeSkillIndexName,
} from "./skill-index.js";

describe("skill index", () => {
  it("normalizes skill names for case-insensitive separator-tolerant lookup", () => {
    expect(normalizeSkillIndexName(" Excel_XLSX/demo ")).toBe("excel-xlsx-demo");
    expect(normalizeSkillIndexName("Excel   XLSX")).toBe("excel-xlsx");
    expect(normalizeSkillIndexName("@@")).toBe("");
  });

  it("indexes entries by exact and normalized name without changing input order", () => {
    const entries = [
      createFixtureSkillEntry("Excel XLSX", { skillKey: "excel_xlsx" }),
      createFixtureSkillEntry("GitHub Review"),
    ];

    const index = buildSkillIndex(entries);

    expect(index.entries.map((entry) => entry.name)).toEqual(["Excel XLSX", "GitHub Review"]);
    expect(index.byName.get("Excel XLSX")?.entry).toBe(entries[0]);
    expect(index.byNormalizedName.get("excel-xlsx")?.map((entry) => entry.name)).toEqual([
      "Excel XLSX",
    ]);
    expect(index.byNormalizedName.get("github-review")?.map((entry) => entry.name)).toEqual([
      "GitHub Review",
    ]);
  });

  it("keeps ambiguous normalized names as multiple index entries", () => {
    const entries = [
      createFixtureSkillEntry("Excel/XLSX", { skillKey: "excel-slash" }),
      createFixtureSkillEntry("Excel_XLSX", { skillKey: "excel-underscore" }),
    ];

    const index = buildSkillIndex(entries);

    expect(index.byNormalizedName.get("excel-xlsx")?.map((entry) => entry.name)).toEqual([
      "Excel/XLSX",
      "Excel_XLSX",
    ]);
  });

  it("centralizes runtime, prompt, and command exposure policy", () => {
    const runtimeHidden = createFixtureSkillEntry("runtime-hidden", {
      exposure: {
        includeInRuntimeRegistry: false,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    });
    const promptHidden = createFixtureSkillEntry("prompt-hidden", {
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: false,
        userInvocable: true,
      },
    });
    const commandHidden = createFixtureSkillEntry("command-hidden", {
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: false,
      },
    });
    const legacyPromptHidden = createFixtureSkillEntry("legacy-prompt-hidden", {
      invocation: { disableModelInvocation: true, userInvocable: true },
    });

    const index = buildSkillIndex([runtimeHidden, promptHidden, commandHidden, legacyPromptHidden]);

    expect(index.runtimeEntries.map((entry) => entry.skill.name)).toEqual([
      "prompt-hidden",
      "command-hidden",
      "legacy-prompt-hidden",
    ]);
    expect(index.promptVisibleEntries.map((entry) => entry.skill.name)).toEqual([
      "runtime-hidden",
      "command-hidden",
    ]);
    expect(index.userInvocableEntries.map((entry) => entry.skill.name)).toEqual([
      "runtime-hidden",
      "prompt-hidden",
      "legacy-prompt-hidden",
    ]);
    expect(filterPromptVisibleSkillEntries(index.entries.map((entry) => entry.entry))).toEqual([
      runtimeHidden,
      commandHidden,
    ]);
    expect(filterUserInvocableSkillEntries(index.entries.map((entry) => entry.entry))).toEqual([
      runtimeHidden,
      promptHidden,
      legacyPromptHidden,
    ]);
    expect(isSkillRuntimeVisible(runtimeHidden)).toBe(false);
    expect(isSkillPromptVisible(legacyPromptHidden)).toBe(false);
    expect(isSkillUserInvocable(commandHidden)).toBe(false);
  });

  it("records source, bundled state, skill key, and agent filter state", () => {
    const bundled = createFixtureSkillEntry("bundle", { source: "openclaw-bundled" });
    const unknownBundled = createFixtureSkillEntry("unknown-bundle", { source: "unknown" });
    const workspace = createFixtureSkillEntry("workspace", {
      source: "openclaw-workspace",
      skillKey: "workspace-key",
    });

    const index = buildSkillIndex([bundled, unknownBundled, workspace], {
      bundledNames: new Set(["unknown-bundle"]),
      agentSkillFilter: ["workspace"],
    });

    expect(index.byName.get("bundle")).toMatchObject({
      source: "openclaw-bundled",
      bundled: true,
      agentAllowed: false,
    });
    expect(index.byName.get("unknown-bundle")).toMatchObject({
      source: "unknown",
      bundled: true,
      agentAllowed: false,
    });
    expect(index.byName.get("workspace")).toMatchObject({
      source: "openclaw-workspace",
      bundled: false,
      skillKey: "workspace-key",
      agentAllowed: true,
    });
    expect(
      buildSkillIndexEntries([bundled, unknownBundled, workspace], {
        bundledNames: new Set(["unknown-bundle"]),
        agentSkillFilter: ["workspace"],
      }).map(({ name, bundled, agentAllowed }) => ({ name, bundled, agentAllowed })),
    ).toEqual([
      { name: "bundle", bundled: true, agentAllowed: false },
      { name: "unknown-bundle", bundled: true, agentAllowed: false },
      { name: "workspace", bundled: false, agentAllowed: true },
    ]);
  });
});
