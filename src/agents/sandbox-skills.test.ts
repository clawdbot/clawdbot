import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveSandboxContext } from "./sandbox/context.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";

vi.mock("./sandbox/docker.js", () => ({
  ensureSandboxContainer: vi.fn(async () => "openclaw-sbx-test"),
}));

vi.mock("./sandbox/browser.js", () => ({
  ensureSandboxBrowser: vi.fn(async () => null),
}));

vi.mock("./sandbox/prune.js", () => ({
  maybePruneSandboxes: vi.fn(async () => undefined),
}));

vi.mock("./sandbox/registry.js", () => ({
  updateRegistry: vi.fn(async () => undefined),
}));

describe("sandbox skill mirroring", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempRoot = "";

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  const runContext = async (workspaceAccess: "none" | "ro") => {
    const bundledDir = await fs.mkdtemp(path.join(tempRoot, "bundled-"));
    await fs.mkdir(bundledDir, { recursive: true });

    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = bundledDir;

    const workspaceDir = await fs.mkdtemp(path.join(tempRoot, "workspace-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Demo skill",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess,
            workspaceRoot: path.join(bundledDir, "sandboxes"),
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    return { context, workspaceDir };
  };

  it.each(["ro", "none"] as const)(
    "copies skills into the sandbox when workspaceAccess is %s",
    async (workspaceAccess) => {
      const { context } = await runContext(workspaceAccess);

      expect(context?.enabled).toBe(true);
      const skillPath = path.join(context?.workspaceDir ?? "", "skills", "demo-skill", "SKILL.md");
      await expect(fs.readFile(skillPath, "utf-8")).resolves.toContain("demo-skill");
    },
    20_000,
  );
});
