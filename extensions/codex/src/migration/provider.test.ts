import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexMigrationProvider } from "./provider.js";

const tempRoots = new Set<string>();

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-codex-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function makeContext(params: {
  source: string;
  stateDir: string;
  workspaceDir: string;
  overwrite?: boolean;
  reportDir?: string;
}): MigrationProviderContext {
  return {
    config: {
      agents: {
        defaults: {
          workspace: params.workspaceDir,
        },
      },
    } as MigrationProviderContext["config"],
    source: params.source,
    stateDir: params.stateDir,
    overwrite: params.overwrite,
    reportDir: params.reportDir,
    logger,
  };
}

async function createCodexFixture(): Promise<{
  root: string;
  homeDir: string;
  codexHome: string;
  stateDir: string;
  workspaceDir: string;
}> {
  const root = await makeTempRoot();
  const homeDir = path.join(root, "home");
  const codexHome = path.join(root, ".codex");
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  vi.stubEnv("HOME", homeDir);
  await writeFile(path.join(codexHome, "skills", "tweet-helper", "SKILL.md"), "# Tweet helper\n");
  await writeFile(path.join(codexHome, "skills", ".system", "system-skill", "SKILL.md"));
  await writeFile(path.join(homeDir, ".agents", "skills", "personal-style", "SKILL.md"));
  await writeFile(
    path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-primary-runtime",
      "documents",
      "1.0.0",
      ".codex-plugin",
      "plugin.json",
    ),
    JSON.stringify({ name: "documents" }),
  );
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  await writeFile(path.join(codexHome, "hooks", "hooks.json"), "{}\n");
  return { root, homeDir, codexHome, stateDir, workspaceDir };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("buildCodexMigrationProvider", () => {
  it("plans Codex skills while keeping plugins and native config explicit", async () => {
    const fixture = await createCodexFixture();
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(plan.providerId).toBe("codex");
    expect(plan.source).toBe(fixture.codexHome);
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "skill:tweet-helper",
          kind: "skill",
          action: "copy",
          status: "planned",
          target: path.join(fixture.workspaceDir, "skills", "tweet-helper"),
        }),
        expect.objectContaining({
          id: "skill:personal-style",
          kind: "skill",
          action: "copy",
          status: "planned",
          target: path.join(fixture.workspaceDir, "skills", "personal-style"),
        }),
        expect.objectContaining({
          id: "plugin:documents:1",
          kind: "manual",
          action: "manual",
          status: "skipped",
        }),
        expect.objectContaining({
          id: "archive:config.toml",
          kind: "archive",
          action: "archive",
          status: "planned",
        }),
        expect.objectContaining({
          id: "archive:hooks/hooks.json",
          kind: "archive",
          action: "archive",
          status: "planned",
        }),
      ]),
    );
    expect(plan.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "skill:system-skill" })]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Codex native plugins are reported for manual review only"),
      ]),
    );
  });

  it("copies planned skills and archives native config during apply", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const provider = buildCodexMigrationProvider();

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir,
      }),
    );

    await expect(
      fs.access(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(fixture.workspaceDir, "skills", "personal-style", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(reportDir, "archive", "config.toml")),
    ).resolves.toBeUndefined();
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "plugin:documents:1", status: "skipped" }),
        expect.objectContaining({ id: "skill:tweet-helper", status: "migrated" }),
        expect.objectContaining({ id: "archive:config.toml", status: "migrated" }),
      ]),
    );
    await expect(fs.access(path.join(reportDir, "report.json"))).resolves.toBeUndefined();
  });

  it("reports existing skill targets as conflicts unless overwrite is set", async () => {
    const fixture = await createCodexFixture();
    await writeFile(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md"));
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );
    const overwritePlan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        overwrite: true,
      }),
    );

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:tweet-helper", status: "conflict" }),
      ]),
    );
    expect(overwritePlan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:tweet-helper", status: "planned" }),
      ]),
    );
  });
});
