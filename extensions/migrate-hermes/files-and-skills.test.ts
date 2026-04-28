import fs from "node:fs/promises";
import path from "node:path";
import { MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import { afterEach, describe, expect, it } from "vitest";
import { buildHermesMigrationProvider } from "./provider.js";
import { cleanupTempRoots, makeContext, makeTempRoot, writeFile } from "./test/provider-helpers.js";

describe("Hermes migration file and skill items", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  function configRuntime(config: Record<string, unknown>) {
    return {
      config: {
        current: () => config,
        mutateConfigFile: async ({
          mutate,
        }: {
          mutate: (draft: Record<string, unknown>) => void | Promise<void>;
        }) => {
          const next = structuredClone(config);
          await mutate(next);
          Object.keys(config).forEach((key) => {
            delete config[key];
          });
          Object.assign(config, next);
          return { nextConfig: next };
        },
      },
    } as never;
  }

  it("reports normalized skill-name collisions instead of overwriting during apply", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(source, "skills", "Ship It", "SKILL.md"), "# Ship It\n");
    await writeFile(path.join(source, "skills", "ship-it", "SKILL.md"), "# ship-it\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir }));
    const skillItems = plan.items.filter((item) => item.kind === "skill");

    expect(skillItems).toHaveLength(2);
    expect(skillItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "skill:ship-it",
          status: "conflict",
          reason: 'multiple Hermes skill directories normalize to "ship-it"',
          target: path.join(workspaceDir, "skills", "ship-it"),
        }),
      ]),
    );

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        overwrite: true,
        reportDir: path.join(root, "report"),
      }),
    );

    expect(result.summary.conflicts).toBe(2);
    await expect(fs.access(path.join(workspaceDir, "skills", "ship-it"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports late-created copy targets as conflicts without overwriting", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(path.join(source, "AGENTS.md"), "# Hermes agents\n");

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({ source, stateDir, workspaceDir, reportDir });
    const plan = await provider.plan(ctx);
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Late agents\n");

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workspace:AGENTS.md",
          status: "conflict",
          reason: MIGRATION_REASON_TARGET_EXISTS,
        }),
      ]),
    );
    expect(result.summary.conflicts).toBe(1);
    expect(await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8")).toBe("# Late agents\n");
  });

  it("applies files, appended memories, item backups, reports, and opt-in API keys", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(path.join(source, "AGENTS.md"), "# Hermes agents\n");
    await writeFile(path.join(source, "memories", "MEMORY.md"), "memory line\n");
    await writeFile(path.join(source, "skills", "Ship It", "SKILL.md"), "# Ship It\n");
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Existing agents\n");

    const provider = buildHermesMigrationProvider();
    const config: Record<string, unknown> = {};
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        includeSecrets: true,
        overwrite: true,
        reportDir,
        runtime: configRuntime(config),
      }),
    );

    expect(result.summary.errors).toBe(0);
    expect(result.summary.conflicts).toBe(0);
    expect(await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8")).toBe(
      "# Hermes agents\n",
    );
    expect(
      await fs.readFile(path.join(workspaceDir, "skills", "ship-it", "SKILL.md"), "utf8"),
    ).toBe("# Ship It\n");
    await expect(fs.access(path.join(reportDir, "summary.md"))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toContain(
      "Imported from Hermes",
    );
    const copiedAgentsItem = result.items.find((item) => item.id === "workspace:AGENTS.md");
    expect(copiedAgentsItem?.details?.backupPath).toEqual(expect.stringContaining("AGENTS.md"));
    const authStore = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
        "utf8",
      ),
    ) as { profiles?: Record<string, { key?: string; provider?: string }> };
    expect(authStore.profiles?.["openai:hermes-import"]).toMatchObject({
      provider: "openai",
      key: "sk-hermes",
    });
  });

  it("archives unsupported Hermes state into the report without importing it", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(path.join(source, "logs", "session.log"), "log line\n");
    await writeFile(path.join(source, "auth.json"), '{"token":"opaque"}\n');

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir, reportDir }));

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "archive:logs",
          kind: "archive",
          action: "archive",
          status: "planned",
        }),
        expect.objectContaining({
          id: "archive:auth.json",
          kind: "archive",
          action: "archive",
          status: "planned",
        }),
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("archive-only")]),
    );

    const result = await provider.apply(makeContext({ source, stateDir, workspaceDir, reportDir }));

    expect(result.summary.errors).toBe(0);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "archive:logs",
          status: "migrated",
          target: path.join(reportDir, "archive", "logs"),
        }),
        expect.objectContaining({
          id: "archive:auth.json",
          status: "migrated",
          target: path.join(reportDir, "archive", "auth.json"),
        }),
      ]),
    );
    expect(await fs.readFile(path.join(reportDir, "archive", "logs", "session.log"), "utf8")).toBe(
      "log line\n",
    );
    await expect(fs.access(path.join(workspaceDir, "logs", "session.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
