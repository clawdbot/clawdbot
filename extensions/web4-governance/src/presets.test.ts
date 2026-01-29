import { describe, expect, it } from "vitest";
import {
  getPreset,
  listPresets,
  isPresetName,
  resolvePreset,
  type PresetName,
} from "./presets.js";

describe("Presets", () => {
  const ALL_PRESETS: PresetName[] = ["permissive", "safety", "strict", "audit-only"];

  describe("listPresets", () => {
    it("should return all four presets", () => {
      const presets = listPresets();
      expect(presets).toHaveLength(4);
      const names = presets.map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(ALL_PRESETS));
    });

    it("should have non-empty descriptions", () => {
      for (const preset of listPresets()) {
        expect(preset.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getPreset", () => {
    it("should return preset by name", () => {
      const safety = getPreset("safety");
      expect(safety).toBeDefined();
      expect(safety!.name).toBe("safety");
    });

    it("should return undefined for unknown preset", () => {
      expect(getPreset("nonexistent")).toBeUndefined();
    });
  });

  describe("isPresetName", () => {
    it("should return true for valid preset names", () => {
      for (const name of ALL_PRESETS) {
        expect(isPresetName(name)).toBe(true);
      }
    });

    it("should return false for invalid names", () => {
      expect(isPresetName("bogus")).toBe(false);
      expect(isPresetName("")).toBe(false);
    });
  });

  describe("preset structure validation", () => {
    it("permissive should have no rules and enforce=false", () => {
      const preset = getPreset("permissive")!;
      expect(preset.config.rules).toHaveLength(0);
      expect(preset.config.enforce).toBe(false);
      expect(preset.config.defaultPolicy).toBe("allow");
    });

    it("safety should have rules and enforce=true", () => {
      const preset = getPreset("safety")!;
      expect(preset.config.rules.length).toBeGreaterThan(0);
      expect(preset.config.enforce).toBe(true);
      expect(preset.config.defaultPolicy).toBe("allow");
    });

    it("strict should default deny and have allow rules", () => {
      const preset = getPreset("strict")!;
      expect(preset.config.defaultPolicy).toBe("deny");
      expect(preset.config.enforce).toBe(true);
      expect(preset.config.rules.length).toBeGreaterThan(0);
      // All strict rules should be allow (since default is deny)
      for (const rule of preset.config.rules) {
        expect(rule.decision).toBe("allow");
      }
    });

    it("audit-only should have same rules as safety but enforce=false", () => {
      const safety = getPreset("safety")!;
      const auditOnly = getPreset("audit-only")!;
      expect(auditOnly.config.enforce).toBe(false);
      expect(auditOnly.config.rules).toEqual(safety.config.rules);
    });

    it("no preset should have rules with missing ids", () => {
      for (const preset of listPresets()) {
        for (const rule of preset.config.rules) {
          expect(rule.id).toBeTruthy();
          expect(rule.name).toBeTruthy();
          expect(typeof rule.priority).toBe("number");
          expect(["allow", "deny", "warn"]).toContain(rule.decision);
        }
      }
    });
  });

  describe("resolvePreset", () => {
    it("should return preset config with no overrides", () => {
      const config = resolvePreset("safety");
      const preset = getPreset("safety")!;
      expect(config.defaultPolicy).toBe(preset.config.defaultPolicy);
      expect(config.enforce).toBe(preset.config.enforce);
      expect(config.rules).toEqual(preset.config.rules);
    });

    it("should override defaultPolicy", () => {
      const config = resolvePreset("safety", { defaultPolicy: "deny" });
      expect(config.defaultPolicy).toBe("deny");
    });

    it("should override enforce", () => {
      const config = resolvePreset("safety", { enforce: false });
      expect(config.enforce).toBe(false);
    });

    it("should append additional rules after preset rules", () => {
      const extra = {
        rules: [
          {
            id: "extra-rule",
            name: "Extra",
            priority: 100,
            decision: "deny" as const,
            match: { tools: ["Write"] },
          },
        ],
      };
      const config = resolvePreset("safety", extra);
      const presetRules = getPreset("safety")!.config.rules;
      expect(config.rules.length).toBe(presetRules.length + 1);
      expect(config.rules[config.rules.length - 1]!.id).toBe("extra-rule");
    });

    it("should not mutate the original preset", () => {
      const before = getPreset("safety")!.config.rules.length;
      resolvePreset("safety", {
        rules: [
          {
            id: "tmp",
            name: "tmp",
            priority: 99,
            decision: "deny",
            match: { tools: ["Bash"] },
          },
        ],
      });
      expect(getPreset("safety")!.config.rules.length).toBe(before);
    });

    it("should throw for unknown preset name", () => {
      expect(() => resolvePreset("bogus")).toThrow("Unknown policy preset");
    });

    it("should not append empty rules array", () => {
      const config = resolvePreset("safety", { rules: [] });
      expect(config.rules).toEqual(getPreset("safety")!.config.rules);
    });
  });
});
