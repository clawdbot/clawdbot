// Schema acceptance for agents.defaults.mediaLocalRoots (issue #47002).
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("agents.defaults.mediaLocalRoots config", () => {
  it("accepts mediaLocalRoots under agents.defaults", () => {
    const result = validateConfigObjectRaw({
      agents: {
        defaults: {
          mediaLocalRoots: ["/data/snapshots", "~/captures"],
          mediaMaxMb: 20,
        },
        entries: { main: { default: true } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      expect(result.issues).toEqual([]);
      return;
    }
    expect(result.config.agents?.defaults?.mediaLocalRoots).toEqual([
      "/data/snapshots",
      "~/captures",
    ]);
  });

  it("rejects empty mediaLocalRoots entries", () => {
    const result = validateConfigObjectRaw({
      agents: {
        defaults: {
          mediaLocalRoots: ["   "],
        },
        entries: { main: { default: true } },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.path.includes("mediaLocalRoots"))).toBe(true);
  });

  it("rejects relative mediaLocalRoots entries", () => {
    const result = validateConfigObjectRaw({
      agents: {
        defaults: {
          mediaLocalRoots: ["captures"],
        },
        entries: { main: { default: true } },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.issues.some(
        (issue) =>
          issue.path.includes("mediaLocalRoots") &&
          issue.message.includes("absolute (non-root) paths or start with ~/"),
      ),
    ).toBe(true);
  });

  it("rejects filesystem-root mediaLocalRoots entries", () => {
    const result = validateConfigObjectRaw({
      agents: {
        defaults: {
          mediaLocalRoots: [process.platform === "win32" ? "C:\\" : "/"],
        },
        entries: { main: { default: true } },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.issues.some(
        (issue) =>
          issue.path.includes("mediaLocalRoots") &&
          issue.message.includes("absolute (non-root) paths or start with ~/"),
      ),
    ).toBe(true);
  });

  it("rejects bare ~ and ~/ mediaLocalRoots entries", () => {
    for (const entry of ["~", "~/"] as const) {
      const result = validateConfigObjectRaw({
        agents: {
          defaults: {
            mediaLocalRoots: [entry],
          },
          entries: { main: { default: true } },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("mediaLocalRoots") &&
            issue.message.includes("absolute (non-root) paths or start with ~/"),
        ),
      ).toBe(true);
    }
  });

  it("rejects home-relative entries that collapse to or escape the home directory", () => {
    for (const entry of ["~/captures/..", "~/..", "~/./..", "~/../etc"] as const) {
      const result = validateConfigObjectRaw({
        agents: {
          defaults: {
            mediaLocalRoots: [entry],
          },
          entries: { main: { default: true } },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("mediaLocalRoots") &&
            issue.message.includes("absolute (non-root) paths or start with ~/"),
        ),
      ).toBe(true);
    }
  });
});
