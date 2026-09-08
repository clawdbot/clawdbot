import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopConfig } from "./config.js";

describe("resolveSkillWorkshopConfig", () => {
  it("defaults autonomous learning to auto", () => {
    expect(resolveSkillWorkshopConfig().autonomous.mode).toBe("auto");
  });

  it.each(["off", "propose", "auto"] as const)("reads autonomous mode %s", (mode) => {
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { autonomous: { mode } } } }).autonomous
        .mode,
    ).toBe(mode);
  });

  it("reads a configured review model ref and ignores blank values", () => {
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { model: " openrouter/deepseek/x " } } })
        .model,
    ).toBe("openrouter/deepseek/x");
    expect(resolveSkillWorkshopConfig({ skills: { workshop: { model: "  " } } }).model).toBe(
      undefined,
    );
    expect(resolveSkillWorkshopConfig().model).toBeUndefined();
  });

  it("does not read the retired boolean key at runtime", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: { workshop: { autonomous: { enabled: false } } },
      } as never).autonomous.mode,
    ).toBe("auto");
  });
});
