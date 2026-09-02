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
