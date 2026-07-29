// Skill index tests cover normalized skill names and discovery index behavior.
import { describe, expect, it } from "vitest";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import {
  buildSkillIndexEntries,
  filterPromptVisibleSkillEntries,
  filterUserInvocableSkillEntries,
  normalizeSkillIndexName,
} from "./skill-index.js";

describe("skill index", () => {
  it("normalizes skill names for case-insensitive separator-tolerant lookup", () => {
    expect(normalizeSkillIndexName(" Excel_XLSX/demo ")).toBe("excel-xlsx-demo");
    expect(normalizeSkillIndexName("Excel   XLSX")).toBe("excel-xlsx");
    expect(normalizeSkillIndexName("@@")).toBe("");
  });

  it("indexes entries without changing input order", () => {
    const entries = [
      createFixtureSkillEntry("Excel XLSX", { skillKey: "excel_xlsx" }),
      createFixtureSkillEntry("GitHub Review"),
    ];

    expect(buildSkillIndexEntries(entries).map((entry) => entry.name)).toEqual([
      "Excel XLSX",
      "GitHub Review",
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

    const entries = [runtimeHidden, promptHidden, commandHidden, legacyPromptHidden];
    const indexEntries = buildSkillIndexEntries(entries);

    expect(indexEntries.filter((entry) => entry.runtimeVisible).map((entry) => entry.name)).toEqual(
      ["prompt-hidden", "command-hidden", "legacy-prompt-hidden"],
    );
    expect(indexEntries.filter((entry) => entry.promptVisible).map((entry) => entry.name)).toEqual([
      "runtime-hidden",
      "command-hidden",
    ]);
    expect(indexEntries.filter((entry) => entry.userInvocable).map((entry) => entry.name)).toEqual([
      "runtime-hidden",
      "prompt-hidden",
      "legacy-prompt-hidden",
    ]);
    expect(filterPromptVisibleSkillEntries(entries)).toEqual([runtimeHidden, commandHidden]);
    expect(filterUserInvocableSkillEntries(entries)).toEqual([
      runtimeHidden,
      promptHidden,
      legacyPromptHidden,
    ]);
  });

  it("records source, bundled state, skill key, and agent filter state", () => {
    const bundled = createFixtureSkillEntry("bundle", { source: "openclaw-bundled" });
    const unknownBundled = createFixtureSkillEntry("unknown-bundle", { source: "unknown" });
    const workspace = createFixtureSkillEntry("workspace", {
      source: "openclaw-workspace",
      skillKey: "workspace-key",
    });

    const indexEntries = buildSkillIndexEntries([bundled, unknownBundled, workspace], {
      bundledNames: new Set(["unknown-bundle"]),
      agentSkillFilter: ["workspace"],
    });

    expect(indexEntries.find((entry) => entry.name === "bundle")).toMatchObject({
      source: "openclaw-bundled",
      bundled: true,
      agentAllowed: false,
    });
    expect(indexEntries.find((entry) => entry.name === "unknown-bundle")).toMatchObject({
      source: "unknown",
      bundled: true,
      agentAllowed: false,
    });
    expect(indexEntries.find((entry) => entry.name === "workspace")).toMatchObject({
      source: "openclaw-workspace",
      bundled: false,
      skillKey: "workspace-key",
      agentAllowed: true,
    });
    expect(
      buildSkillIndexEntries([bundled, unknownBundled, workspace], {
        bundledNames: new Set(["unknown-bundle"]),
        agentSkillFilter: ["workspace"],
      }).map(({ name, bundled: bundledLocal, agentAllowed }) => ({
        name,
        bundled: bundledLocal,
        agentAllowed,
      })),
    ).toEqual([
      { name: "bundle", bundled: true, agentAllowed: false },
      { name: "unknown-bundle", bundled: true, agentAllowed: false },
      { name: "workspace", bundled: false, agentAllowed: true },
    ]);
  });
});
