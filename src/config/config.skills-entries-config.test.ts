import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("skills entries config schema", () => {
  it("accepts custom fields under config", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        entries: {
          "custom-skill": {
            enabled: true,
            config: {
              url: "https://example.invalid",
              token: "abc123",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        entries: {
          "custom-skill": {
            url: "https://example.invalid",
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some(
        (issue) =>
          issue.path.join(".") === "skills.entries.custom-skill" &&
          issue.message.toLowerCase().includes("unrecognized"),
      ),
    ).toBe(true);
  });

  it("accepts agents.defaults.skills", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts agents.list[].skills as explicit replacements", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: ["docs-search"] }],
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts explicit empty skills arrays for defaults and agents", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          skills: [],
        },
        list: [{ id: "writer", skills: [] }],
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts uploaded skill archive install policy", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        install: {
          allowUploadedArchives: true,
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects legacy skills.policy config", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        policy: {
          globalEnabled: ["github"],
        } as never,
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some(
        (issue) =>
          issue.path.join(".") === "skills" && issue.message.toLowerCase().includes("unrecognized"),
      ),
    ).toBe(true);
  });
});
