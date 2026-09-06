import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexExplicitSkillInputs } from "./explicit-skill-input.js";
import type { v2 } from "./protocol.js";

describe("resolveCodexExplicitSkillInputs", () => {
  const cwd = path.resolve("repo");
  const skillPath = path.join(cwd, ".agents", "skills", "release", "SKILL.md");

  it("uses the enabled catalog identity for a path-matched selection", async () => {
    const request = vi.fn(
      async () =>
        ({
          data: [
            {
              cwd,
              skills: [
                {
                  name: "release",
                  description: "Release workflow",
                  path: skillPath,
                  scope: "repo",
                  enabled: true,
                },
              ],
              errors: [],
            },
          ],
        }) satisfies v2.SkillsListResponse,
    );

    await expect(
      resolveCodexExplicitSkillInputs({
        client: { request } as never,
        cwd,
        selections: [{ name: "release-command", path: skillPath }],
      }),
    ).resolves.toEqual([{ type: "skill", name: "release", path: skillPath }]);
    expect(request).toHaveBeenCalledWith(
      "skills/list",
      { cwds: [cwd], forceReload: false },
      { signal: undefined },
    );
  });

  it("skips disabled and unmatched selections", async () => {
    const request = vi.fn(
      async () =>
        ({
          data: [
            {
              cwd,
              skills: [
                {
                  name: "release",
                  description: "Release workflow",
                  path: skillPath,
                  scope: "repo",
                  enabled: false,
                },
              ],
              errors: [],
            },
          ],
        }) satisfies v2.SkillsListResponse,
    );

    await expect(
      resolveCodexExplicitSkillInputs({
        client: { request } as never,
        cwd,
        selections: [
          { name: "release", path: skillPath },
          { name: "missing", path: path.join(cwd, "missing", "SKILL.md") },
        ],
      }),
    ).resolves.toEqual([]);
  });

  it("fails open when the catalog request fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("skills/list unavailable");
    });

    await expect(
      resolveCodexExplicitSkillInputs({
        client: { request } as never,
        cwd,
        selections: [{ name: "release", path: skillPath }],
      }),
    ).resolves.toEqual([]);
  });

  it("does not request the catalog without selections", async () => {
    const request = vi.fn();

    await expect(
      resolveCodexExplicitSkillInputs({ client: { request } as never, cwd, selections: [] }),
    ).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
