import fs from "node:fs/promises";
import path from "node:path";
import { createTempHomeEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import {
  applyCodexNativeSkillIsolation,
  resolveCodexNativeSkillIsolation,
} from "./native-skill-isolation.js";

it("reuses one authoritative native skill reload per physical client and workspace", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-client-cache-");
  try {
    const home = await fs.realpath(tempHome.home);
    const request = vi.fn(async () => ({
      data: [{ cwd: home, errors: [], skills: [] }],
    }));
    const client = { request } as unknown as CodexAppServerClient;

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
        const params = { client, cwd: home };
        const [first, second] = await Promise.all([
          resolveCodexNativeSkillIsolation(params),
          resolveCodexNativeSkillIsolation(params),
        ]);
        expect(second).toBe(first);
        expect(request).toHaveBeenCalledTimes(1);

        await resolveCodexNativeSkillIsolation({
          client,
          cwd: path.join(home, "another-workspace"),
        });
        expect(request).toHaveBeenCalledTimes(2);
      },
    );
  } finally {
    await tempHome.restore();
  }
});

it("retries a failed native skill reload instead of caching its rejection", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-cache-retry-");
  try {
    const home = await fs.realpath(tempHome.home);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("skill reload failed"))
      .mockResolvedValue({ data: [{ cwd: home, errors: [], skills: [] }] });
    const client = { request } as unknown as CodexAppServerClient;

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
        const params = { client, cwd: home };
        await expect(resolveCodexNativeSkillIsolation(params)).rejects.toThrow(
          "skill reload failed",
        );
        await expect(resolveCodexNativeSkillIsolation(params)).resolves.toEqual({
          disabledUserSkillPaths: [],
        });
        expect(request).toHaveBeenCalledTimes(2);
      },
    );
  } finally {
    await tempHome.restore();
  }
});

it("does not share native skill reloads across independently cancellable turns", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-cache-signals-");
  try {
    const home = await fs.realpath(tempHome.home);
    const request = vi.fn(async () => ({
      data: [{ cwd: home, errors: [], skills: [] }],
    }));
    const client = { request } as unknown as CodexAppServerClient;
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
        await Promise.all([
          resolveCodexNativeSkillIsolation({ client, cwd: home, signal: firstSignal.signal }),
          resolveCodexNativeSkillIsolation({ client, cwd: home, signal: secondSignal.signal }),
        ]);
        expect(request).toHaveBeenCalledTimes(2);
        await resolveCodexNativeSkillIsolation({
          client,
          cwd: home,
          signal: new AbortController().signal,
        });
        expect(request).toHaveBeenCalledTimes(2);
      },
    );
  } finally {
    await tempHome.restore();
  }
});

it("disables native user-scope skills only for non-default state directories", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-");
  try {
    // macOS exposes os.tmpdir() through /var while real paths use /private/var.
    const home = await fs.realpath(tempHome.home);
    const workspace = path.join(home, "workspace");
    const personalSkill = path.join(home, ".claude", "skills", "personal", "SKILL.md");
    const projectSkill = path.join(workspace, ".agents", "skills", "project", "SKILL.md");
    const pluginSkill = path.join(home, "plugin-cache", "skills", "plugin", "SKILL.md");
    const hiddenSkill = path.join(home, ".claude", "skills", ".git", "hidden", "SKILL.md");
    const customCodexHomeTarget = path.join(home, ".codex-work");
    const customCodexHome = path.join(home, "scratch-state", "codex-home");
    const customCodexSkill = path.join(customCodexHomeTarget, "skills", "custom", "SKILL.md");
    const stateOwnedCodexSkill = path.join(customCodexHome, "skills", "state-owned", "SKILL.md");
    const nestedSymlinkTarget = path.join(home, "nested-skill-tree");
    const nestedSymlinkSkill = path.join(nestedSymlinkTarget, "nested", "SKILL.md");
    const skillNamedDirectoryLink = path.join(home, ".agents", "skills", "linked", "SKILL.md");
    await fs.mkdir(path.dirname(personalSkill), { recursive: true });
    await fs.mkdir(path.dirname(projectSkill), { recursive: true });
    await fs.mkdir(path.dirname(pluginSkill), { recursive: true });
    await fs.mkdir(path.dirname(hiddenSkill), { recursive: true });
    await fs.mkdir(path.dirname(customCodexSkill), { recursive: true });
    await fs.mkdir(path.join(customCodexHome, "skills"), { recursive: true });
    await fs.mkdir(path.dirname(stateOwnedCodexSkill), { recursive: true });
    await fs.mkdir(path.dirname(nestedSymlinkSkill), { recursive: true });
    await fs.mkdir(path.dirname(skillNamedDirectoryLink), { recursive: true });
    await fs.writeFile(personalSkill, "personal");
    await fs.writeFile(projectSkill, "project");
    await fs.writeFile(pluginSkill, "plugin");
    await fs.writeFile(hiddenSkill, "hidden");
    await fs.writeFile(customCodexSkill, "custom");
    await fs.writeFile(stateOwnedCodexSkill, "state-owned");
    await fs.writeFile(nestedSymlinkSkill, "nested");
    await fs.symlink(
      path.join(customCodexHomeTarget, "skills", "custom"),
      path.join(customCodexHome, "skills", "custom"),
      "dir",
    );
    await fs.symlink(nestedSymlinkTarget, skillNamedDirectoryLink, "dir");
    const personalSkillRealPath = await fs.realpath(personalSkill);
    const projectSkillRealPath = await fs.realpath(projectSkill);
    const pluginSkillRealPath = await fs.realpath(pluginSkill);
    const hiddenSkillRealPath = await fs.realpath(hiddenSkill);
    const customCodexSkillRealPath = await fs.realpath(customCodexSkill);
    const stateOwnedCodexSkillRealPath = await fs.realpath(stateOwnedCodexSkill);
    const nestedSymlinkSkillRealPath = await fs.realpath(nestedSymlinkSkill);
    const request = vi.fn(async () => ({
      data: [
        {
          cwd: workspace,
          errors: [],
          skills: [
            {
              name: "personal",
              description: "Personal",
              path: personalSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "project",
              description: "Project",
              path: projectSkillRealPath,
              scope: "repo" as const,
              enabled: true,
            },
            {
              name: "plugin",
              description: "Plugin",
              path: pluginSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "hidden",
              description: "Hidden",
              path: hiddenSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "custom",
              description: "Custom Codex home",
              path: customCodexSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "state-owned",
              description: "State-owned Codex home",
              path: stateOwnedCodexSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "nested",
              description: "Nested through a SKILL.md directory symlink",
              path: nestedSymlinkSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
          ],
        },
      ],
    }));
    const client = { request } as unknown as CodexAppServerClient;

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
      async () => {
        await expect(
          resolveCodexNativeSkillIsolation({ client, codexHome: customCodexHome, cwd: workspace }),
        ).resolves.toBe(undefined);
      },
    );
    expect(request).not.toHaveBeenCalled();

    const isolation = await withEnvAsync(
      {
        HOME: path.join(home, "gateway-home"),
        OPENCLAW_STATE_DIR: path.join(home, "scratch-state"),
      },
      async () =>
        await resolveCodexNativeSkillIsolation({
          client,
          codexHome: customCodexHome,
          cwd: workspace,
          home,
        }),
    );
    expect(request).toHaveBeenCalledWith(
      "skills/list",
      { cwds: [workspace], forceReload: true },
      { signal: undefined },
    );
    expect(
      applyCodexNativeSkillIsolation(
        { "skills.config": [{ path: projectSkillRealPath, enabled: true }] },
        isolation,
      ),
    ).toMatchObject({
      "skills.include_instructions": false,
      "skills.config": [
        { path: projectSkillRealPath, enabled: true },
        { path: personalSkillRealPath, enabled: false },
        { path: customCodexSkillRealPath, enabled: false },
        { path: nestedSymlinkSkillRealPath, enabled: false },
      ],
    });
  } finally {
    await tempHome.restore();
  }
});

it.runIf(process.platform !== "win32")(
  "fails closed to all native user skills when a personal root is unreadable",
  async () => {
    const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-fail-closed-");
    try {
      const home = await fs.realpath(tempHome.home);
      const skillsDir = path.join(home, ".claude", "skills");
      const personalSkill = path.join(skillsDir, "personal", "SKILL.md");
      const outsideSkill = path.join(home, "plugin-cache", "outside", "SKILL.md");
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.mkdir(path.dirname(personalSkill), { recursive: true });
      await fs.mkdir(path.dirname(outsideSkill), { recursive: true });
      await fs.writeFile(personalSkill, "personal");
      await fs.writeFile(outsideSkill, "outside");
      await fs.symlink(path.join(skillsDir, "loop"), path.join(skillsDir, "loop"));
      const personalSkillRealPath = await fs.realpath(personalSkill);
      const outsideSkillRealPath = await fs.realpath(outsideSkill);
      const client = {
        request: vi.fn(async () => ({
          data: [
            {
              cwd: home,
              errors: [],
              skills: [
                {
                  name: "outside",
                  description: "Outside",
                  path: outsideSkillRealPath,
                  scope: "user" as const,
                  enabled: true,
                },
              ],
            },
          ],
        })),
      } as unknown as CodexAppServerClient;

      const isolation = await withEnvAsync(
        { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
        async () => await resolveCodexNativeSkillIsolation({ client, cwd: home }),
      );
      expect(isolation?.disabledUserSkillPaths).toEqual([
        personalSkillRealPath,
        outsideSkillRealPath,
      ]);
    } finally {
      await tempHome.restore();
    }
  },
);

it("captures a personal skill created during the authoritative Codex reload", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-reload-race-");
  try {
    const home = await fs.realpath(tempHome.home);
    const skillPath = path.join(home, ".claude", "skills", "late", "SKILL.md");
    const client = {
      request: vi.fn(async () => {
        await fs.mkdir(path.dirname(skillPath), { recursive: true });
        await fs.writeFile(skillPath, "late");
        return { data: [{ cwd: home, errors: [], skills: [] }] };
      }),
    } as unknown as CodexAppServerClient;

    const isolation = await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => await resolveCodexNativeSkillIsolation({ client, cwd: home }),
    );
    expect(isolation?.disabledUserSkillPaths).toEqual([await fs.realpath(skillPath)]);
  } finally {
    await tempHome.restore();
  }
});

it("preserves direct skills under a state-owned default Codex home", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-state-home-");
  try {
    const stateHome = await fs.realpath(tempHome.home);
    const skillPath = path.join(stateHome, ".codex", "skills", "state-owned", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "state-owned");
    const skillRealPath = await fs.realpath(skillPath);
    const client = {
      request: vi.fn(async () => ({
        data: [
          {
            cwd: stateHome,
            errors: [],
            skills: [
              {
                name: "state-owned",
                description: "State owned",
                path: skillRealPath,
                scope: "user" as const,
                enabled: true,
              },
            ],
          },
        ],
      })),
    } as unknown as CodexAppServerClient;

    const isolation = await withEnvAsync(
      { HOME: stateHome, OPENCLAW_STATE_DIR: stateHome },
      async () => await resolveCodexNativeSkillIsolation({ client, cwd: stateHome }),
    );
    expect(isolation?.disabledUserSkillPaths).toEqual([]);
  } finally {
    await tempHome.restore();
  }
});
