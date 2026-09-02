import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { assertConfiguredWorkspaceStateReady } from "../agents/workspace-state-dirs.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

describe("shared-root workspace Doctor migration", () => {
  const { detect, migrate, setup } = useWorkspaceMigrationTestFixture();

  it.each(["implicit agent", "explicit fleet"])(
    "imports both shared-root setup markers without moving workspace content: %s",
    async (roster) => {
      const context = setup();
      const cfg = {
        ...context.cfg,
        agents: {
          ...context.cfg.agents,
          ...(roster === "explicit fleet"
            ? { ownership: "explicit" as const, entries: { main: {}, other: {} } }
            : {}),
        },
      };
      const originalConfig = structuredClone(cfg);
      const effectiveDirs = listAgentWorkspaceDirs(cfg, context.env);
      const corpus = ["SOUL.md", "memory/retained.md"];
      const originalCorpus = await Promise.all(
        corpus.map(async (relativePath) => {
          const filePath = path.join(context.workspaceDir, relativePath);
          await fsp.mkdir(path.dirname(filePath), { recursive: true });
          await fsp.writeFile(filePath, `Retained ${relativePath}\n`);
          const { uid, gid, mode } = await fsp.stat(filePath);
          return { bytes: await fsp.readFile(filePath), uid, gid, mode };
        }),
      );
      const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
      const rootPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
      const nestedPath = path.join(context.workspaceDir, ".openclaw", "workspace-state.json");
      const rootSeededAt = "2026-07-15T10:00:00.000Z";
      const completedAt = "2026-07-15T10:01:00.000Z";
      await fsp.mkdir(path.dirname(nestedPath), { recursive: true });
      await fsp.writeFile(
        rootPath,
        JSON.stringify({
          version: 1,
          bootstrapSeededAt: rootSeededAt,
          setupCompletedAt: completedAt,
        }),
        "utf8",
      );
      await fsp.writeFile(
        nestedPath,
        JSON.stringify({ version: 1, bootstrapSeededAt: "2026-07-14T09:00:00.000Z" }),
        "utf8",
      );

      if (roster === "explicit fleet") {
        expect(effectiveDirs).toEqual(
          ["main", "other"].map((id) => path.join(context.workspaceDir, id)),
        );
        // An unused shared root is a Doctor source, not a runtime admission requirement.
        expect(() => assertConfiguredWorkspaceStateReady({ cfg, env: context.env })).not.toThrow();
      }
      const detected = detect({ ...context, cfg });
      expect(
        detected.sources
          .filter((source) => source.kind === "setup")
          .map((source) => source.sourcePath)
          .toSorted(),
      ).toEqual([rootPath, nestedPath].map((filePath) => fs.realpathSync(filePath)).toSorted());
      const result = await migrate({ ...context, cfg });

      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(rootPath)).toBe(false);
      expect(fs.existsSync(nestedPath)).toBe(false);
      expect(
        openOpenClawStateDatabase({ env: context.env })
          .db.prepare(
            "SELECT bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?",
          )
          .get(identity.workspaceKey),
      ).toEqual({ bootstrap_seeded_at: rootSeededAt, setup_completed_at: completedAt });
      expect(cfg).toEqual(originalConfig);
      expect(listAgentWorkspaceDirs(cfg, context.env)).toEqual(effectiveDirs);
      for (const [index, relativePath] of corpus.entries()) {
        const filePath = path.join(context.workspaceDir, relativePath);
        const { uid, gid, mode } = await fsp.stat(filePath);
        expect({ bytes: await fsp.readFile(filePath), uid, gid, mode }).toEqual(
          originalCorpus[index],
        );
      }
      expect(detect({ ...context, cfg })).toEqual({ sources: [], hasLegacy: false });
      expect(await migrate({ ...context, cfg })).toEqual({ changes: [], warnings: [] });
    },
  );
});
