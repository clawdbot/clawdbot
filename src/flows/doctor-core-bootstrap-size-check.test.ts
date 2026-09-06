import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import type { HealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

function getBootstrapSizeCheck(): HealthCheck {
  const check = CORE_HEALTH_CHECKS.find(
    (candidate) => candidate.id === "core/doctor/bootstrap-size",
  );
  if (!check || !("detect" in check)) {
    throw new Error("missing bootstrap-size health check");
  }
  return check;
}

describe("core/doctor/bootstrap-size", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("does not create shared state while inspecting bootstrap files", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-bootstrap-readonly-"));
    await fs.writeFile(join(tmp, "AGENTS.md"), "bootstrap", "utf-8");
    const stateDir = join(tmp, "state-root");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await expect(
      getBootstrapSizeCheck().detect({
        mode: "lint",
        runtime,
        cfg: { agents: { defaults: { workspace: tmp } } },
        cwd: tmp,
      }),
    ).resolves.toEqual([]);
    await expect(fs.stat(join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("counts files added by the bundled bootstrap-extra-files hook without the hook runtime", async () => {
    tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "openclaw-health-bootstrap-extra-")));
    await fs.writeFile(join(tmp, "AGENTS.md"), "bootstrap", "utf-8");
    await fs.mkdir(join(tmp, "packages", "core"), { recursive: true });
    await fs.writeFile(join(tmp, "packages", "core", "SOUL.md"), "a".repeat(15_000), "utf-8");

    const findings = await getBootstrapSizeCheck().detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: { defaults: { workspace: tmp, bootstrapMaxChars: 10_000 } },
        hooks: {
          internal: {
            entries: {
              "bootstrap-extra-files": { enabled: true, paths: ["packages/*/SOUL.md"] },
            },
          },
        },
      },
      cwd: tmp,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: expect.stringContaining("SOUL.md"),
        path: join(tmp, "packages", "core", "SOUL.md"),
      }),
    );
  });

  it("reports a hook-added extra file the total bootstrap budget dropped", async () => {
    // The extra repeats the root basename, so only source-path identity can tell
    // the doctor that this file received no injected bytes at all.
    tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "openclaw-health-bootstrap-drop-")));
    await fs.writeFile(join(tmp, "AGENTS.md"), "a".repeat(1_000), "utf-8");
    await fs.mkdir(join(tmp, "packages", "core"), { recursive: true });
    await fs.writeFile(join(tmp, "packages", "core", "AGENTS.md"), "b".repeat(500), "utf-8");

    const findings = await getBootstrapSizeCheck().detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: { defaults: { workspace: tmp, bootstrapTotalMaxChars: 1_000 } },
        hooks: {
          internal: {
            entries: {
              "bootstrap-extra-files": { enabled: true, paths: ["packages/*/AGENTS.md"] },
            },
          },
        },
      },
      cwd: tmp,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: expect.stringContaining("AGENTS.md"),
        path: join(tmp, "packages", "core", "AGENTS.md"),
      }),
    );
  });

  it("honors the per-agent bootstrapMaxChars override in health findings", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-bootstrap-"));
    await fs.writeFile(join(tmp, "AGENTS.md"), "a".repeat(15_000), "utf-8");

    const check = getBootstrapSizeCheck();
    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          defaults: { workspace: tmp, bootstrapMaxChars: 20_000 },
          list: [{ id: "custom-agent", default: true, bootstrapMaxChars: 10_000 }],
        },
      },
      cwd: tmp,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: expect.stringContaining("AGENTS.md"),
        fixHint: expect.stringContaining("agents.entries.*.bootstrapMaxChars"),
      }),
    );
    await expect(
      check.detect({
        mode: "lint",
        runtime,
        cfg: {
          agents: {
            defaults: { bootstrapMaxChars: 20_000 },
            list: [
              { id: "alpha", default: true, workspace: tmp, bootstrapMaxChars: 10_000 },
              { id: "beta" },
            ],
          },
        },
      }),
    ).resolves.toEqual([]);
  });
});
