import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";

const note = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

async function repairConfig(configPath: string) {
  const ctx = await prepareDoctorContext(configPath);
  await runInitialConfigWriteHealth(ctx);
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

function writeCanvasConfig(home: string, root: string, legacy = false, port?: number) {
  const host = { enabled: false, root, ...(port ? { port } : {}) };
  return writeOpenClawConfig(home, {
    gateway: { mode: "local" },
    ...(legacy
      ? { canvasHost: host }
      : { plugins: { entries: { canvas: { enabled: true, config: { host } } } } }),
  });
}

describe("Canvas document migration through doctor config persistence", () => {
  afterEach(() => {
    note.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  // POSIX permissions exercise real read/copy failures; Windows and root ignore chmod(0).
  it
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each(["partial", "blind", "env-root", "legacy-root"] as const)(
    "retains the root after a %s migration and retires it only after retry",
    async (failure) => {
      await withTempHome(async (home) => {
        const customRoot = path.join(home, "custom-canvas");
        const documents = path.join(customRoot, "documents");
        const coreDocuments = path.join(home, ".openclaw", "canvas", "documents");
        for (const id of ["cv_first", "cv_retry"]) {
          await fs.mkdir(path.join(documents, id), { recursive: true });
          await fs.writeFile(path.join(documents, id, "index.html"), id);
        }
        const configuredRoot = failure === "env-root" ? "${HOME}/custom-canvas" : customRoot;
        const configPath = await writeCanvasConfig(
          home,
          configuredRoot,
          failure === "legacy-root",
          failure === "env-root" ? 18793 : undefined,
        );
        const blockedPath =
          failure === "blind" ? documents : path.join(documents, "cv_retry", "index.html");
        await fs.chmod(blockedPath, 0);
        try {
          const saved = await repairConfig(configPath);
          expect
            .soft(saved.plugins?.entries?.canvas?.config?.host?.root ?? saved.canvasHost?.root)
            .toBe(configuredRoot);
          if (failure === "env-root") {
            // Prove a committed partial repair, not just a refused config write.
            expect.soft(saved.plugins.entries.canvas.config.host).not.toHaveProperty("port");
          }
          const warnings = note.mock.calls
            .filter(([, title]) => title?.includes("warning"))
            .map(([message]) => message)
            .join("\n");
          expect.soft(warnings).toContain("Canvas");
          expect.soft(warnings).toContain("openclaw doctor --fix");
          if (failure === "blind") {
            expect.soft(warnings).toContain("EACCES");
          } else {
            expect.soft(warnings).toContain("cv_retry");
            await expect(
              fs.readFile(path.join(coreDocuments, "cv_first", "index.html"), "utf8"),
            ).resolves.toBe("cv_first");
            await expect(fs.access(path.join(coreDocuments, "cv_retry"))).rejects.toThrow();
            expect(await fs.readdir(coreDocuments)).toEqual(["cv_first"]);
          }
        } finally {
          await fs.chmod(blockedPath, failure === "blind" ? 0o700 : 0o600);
        }

        const saved = await repairConfig(configPath);
        expect(saved.plugins?.entries?.canvas?.config?.host).toEqual({ enabled: false });
        for (const id of ["cv_first", "cv_retry"]) {
          await expect(
            fs.readFile(path.join(coreDocuments, id, "index.html"), "utf8"),
          ).resolves.toBe(id);
          await expect(fs.access(path.join(documents, id))).rejects.toThrow();
        }
        expect((await readConfigFileSnapshot()).valid).toBe(true);
      });
    },
  );

  it.each(["complete", "empty", "absent", "canonical", "canonical-alias", "legacy-root"] as const)(
    "retires a %s root without losing canonical documents",
    async (scenario) => {
      await withTempHome(async (home) => {
        const coreRoot = path.join(home, ".openclaw", "canvas");
        const customRoot = scenario === "canonical" ? coreRoot : path.join(home, "custom-canvas");
        if (scenario === "canonical-alias") {
          await fs.mkdir(coreRoot, { recursive: true });
          await fs.symlink(coreRoot, customRoot, "junction");
        }
        const documents = path.join(customRoot, "documents");
        if (scenario !== "absent") {
          await fs.mkdir(documents, { recursive: true });
        }
        const hasDocument = scenario !== "empty" && scenario !== "absent";
        if (hasDocument) {
          await fs.mkdir(path.join(documents, "cv_existing"));
          await fs.writeFile(path.join(documents, "cv_existing", "index.html"), "existing");
        }
        const saved = await repairConfig(
          await writeCanvasConfig(home, customRoot, scenario === "legacy-root"),
        );
        expect(saved.plugins.entries.canvas.config.host).toEqual({ enabled: false });
        expect(Object.keys(saved.plugins.entries)).toEqual(["canvas"]);
        expect(saved).not.toHaveProperty("canvasHost");
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        if (hasDocument) {
          await expect(
            fs.readFile(path.join(coreRoot, "documents", "cv_existing", "index.html"), "utf8"),
          ).resolves.toBe("existing");
        }
      });
    },
  );
});
