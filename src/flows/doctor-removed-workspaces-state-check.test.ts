// Removed Workspaces state tests cover doctor detection and deletion.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { removedWorkspacesStateCheck } from "./doctor-removed-workspaces-state-check.js";

const runtime = { log() {}, error() {}, exit() {} };

describe("removed Workspaces state doctor check", () => {
  let root: string | undefined;

  async function createStateDir(
    fingerprint: "sqlite" | "widgets-data" = "sqlite",
  ): Promise<string> {
    root = await fs.mkdtemp(join(tmpdir(), "openclaw-workspaces-state-"));
    const staleDir = join(root, "workspaces");
    await fs.mkdir(staleDir, { recursive: true });
    if (fingerprint === "sqlite") {
      await fs.writeFile(join(staleDir, "workspaces.sqlite"), "stale", "utf8");
    } else {
      await Promise.all([
        fs.mkdir(join(staleDir, "widgets"), { recursive: true }),
        fs.mkdir(join(staleDir, "data"), { recursive: true }),
      ]);
    }
    return staleDir;
  }

  afterEach(async () => {
    if (root !== undefined) {
      await fs.rm(root, { force: true, recursive: true });
      root = undefined;
    }
  });

  it("previews and removes the stale plugin state directory", async () => {
    const staleDir = await createStateDir();

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const findings = await removedWorkspacesStateCheck.detect({
        mode: "lint",
        runtime,
        cfg: {},
      });
      expect(findings).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/removed-workspaces-state",
          path: staleDir,
          severity: "warning",
        }),
      ]);
      await expect(
        removedWorkspacesStateCheck.detect(
          { mode: "fix", runtime, cfg: {} },
          { paths: [join(root!, "other")] },
        ),
      ).resolves.toEqual([]);

      const preview = await removedWorkspacesStateCheck.repair?.(
        { mode: "fix", runtime, cfg: {}, dryRun: true },
        findings,
      );
      expect(preview).toMatchObject({
        changes: [expect.stringContaining("Would remove retired Workspaces plugin state")],
        effects: [
          {
            action: "would-remove-retired-workspaces-state",
            dryRunSafe: false,
            kind: "state",
            target: staleDir,
          },
        ],
      });
      await expect(fs.stat(staleDir)).resolves.toBeDefined();

      const repaired = await removedWorkspacesStateCheck.repair?.(
        { mode: "fix", runtime, cfg: {} },
        findings,
      );
      expect(repaired).toMatchObject({
        changes: [expect.stringContaining("Removed retired Workspaces plugin state")],
        effects: [
          {
            action: "remove-retired-workspaces-state",
            dryRunSafe: false,
            kind: "state",
            target: staleDir,
          },
        ],
      });
      await expect(fs.stat(staleDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        removedWorkspacesStateCheck.detect({ mode: "lint", runtime, cfg: {} }),
      ).resolves.toEqual([]);
    });
  });

  it("detects the widgets/data plugin layout fingerprint", async () => {
    const staleDir = await createStateDir("widgets-data");

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      await expect(
        removedWorkspacesStateCheck.detect({ mode: "lint", runtime, cfg: {} }),
      ).resolves.toEqual([
        expect.objectContaining({
          checkId: "core/doctor/removed-workspaces-state",
          path: staleDir,
        }),
      ]);
    });
  });

  it("ignores a plain user directory without plugin fingerprints", async () => {
    root = await fs.mkdtemp(join(tmpdir(), "openclaw-workspaces-state-"));
    const userDir = join(root, "workspaces");
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(join(userDir, "notes.md"), "personal", "utf8");

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      await expect(
        removedWorkspacesStateCheck.detect({ mode: "lint", runtime, cfg: {} }),
      ).resolves.toEqual([]);
      await expect(
        removedWorkspacesStateCheck.repair?.({ mode: "fix", runtime, cfg: {} }, []),
      ).resolves.toMatchObject({ status: "skipped", changes: [] });
      await expect(fs.readFile(join(userDir, "notes.md"), "utf8")).resolves.toBe("personal");
    });
  });

  it.each(["defaults", "agent"] as const)(
    "skips cleanup when the %s workspace resolves to the retired state directory",
    async (kind) => {
      const staleDir = await createStateDir();
      const resolvedAlias = join(staleDir, "..", "workspaces");
      const cfg =
        kind === "defaults"
          ? { agents: { defaults: { workspace: resolvedAlias } } }
          : { agents: { list: [{ id: "ops", workspace: resolvedAlias }] } };

      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const findings = await removedWorkspacesStateCheck.detect({
          mode: "lint",
          runtime,
          cfg,
        });
        expect(findings).toEqual([
          expect.objectContaining({
            message: expect.stringContaining("Automatic removal is disabled"),
            path: staleDir,
            severity: "warning",
          }),
        ]);

        const repaired = await removedWorkspacesStateCheck.repair?.(
          { mode: "fix", runtime, cfg },
          findings,
        );
        expect(repaired).toMatchObject({
          status: "skipped",
          changes: [],
          warnings: [expect.stringContaining("Automatic removal is disabled")],
        });
        await expect(fs.stat(staleDir)).resolves.toBeDefined();
      });
    },
  );

  it("skips cleanup when an agent workspace is nested under the retired state directory", async () => {
    const staleDir = await createStateDir();
    const nestedWorkspace = join(staleDir, "active-agent");
    await fs.mkdir(nestedWorkspace);
    const cfg = { agents: { list: [{ id: "active", workspace: nestedWorkspace }] } };

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const findings = await removedWorkspacesStateCheck.detect({ mode: "lint", runtime, cfg });
      const repaired = await removedWorkspacesStateCheck.repair?.(
        { mode: "fix", runtime, cfg },
        findings,
      );

      expect(repaired).toMatchObject({ status: "skipped", changes: [] });
      await expect(fs.stat(nestedWorkspace)).resolves.toBeDefined();
    });
  });

  it("skips cleanup when an agent workspace symlink resolves beneath the retired state directory", async () => {
    const staleDir = await createStateDir();
    const nestedWorkspace = join(staleDir, "active-agent");
    const workspaceAlias = join(root!, "active-agent-link");
    await fs.mkdir(nestedWorkspace);
    await fs.symlink(nestedWorkspace, workspaceAlias, "dir");
    const cfg = { agents: { defaults: { workspace: workspaceAlias } } };

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const findings = await removedWorkspacesStateCheck.detect({ mode: "lint", runtime, cfg });
      const repaired = await removedWorkspacesStateCheck.repair?.(
        { mode: "fix", runtime, cfg },
        findings,
      );

      expect(repaired).toMatchObject({ status: "skipped", changes: [] });
      await expect(fs.stat(nestedWorkspace)).resolves.toBeDefined();
    });
  });

  it("skips cleanup when the retired state directory is nested under an agent workspace", async () => {
    const staleDir = await createStateDir();
    const cfg = { agents: { defaults: { workspace: root } } };

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const findings = await removedWorkspacesStateCheck.detect({ mode: "lint", runtime, cfg });
      const repaired = await removedWorkspacesStateCheck.repair?.(
        { mode: "fix", runtime, cfg },
        findings,
      );

      expect(repaired).toMatchObject({ status: "skipped", changes: [] });
      await expect(fs.stat(staleDir)).resolves.toBeDefined();
    });
  });
});
