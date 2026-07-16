// Doctor install policy tests cover install policy checks and filesystem diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { noteInstallPolicyHealth } from "./doctor-install-policy.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

async function collectInstallPolicyHealthLines(
  cfg: OpenClawConfig,
  options: { deep?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  noteMock.mockClear();
  await noteInstallPolicyHealth(cfg, options);
  const body = noteMock.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body.split("\n") : [];
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-install-policy-"));
  tempDirs.push(dir);
  return dir;
}

async function writePolicyScript(dir: string, response: string): Promise<string> {
  const scriptPath = path.join(dir, "policy.cjs");
  await fs.writeFile(scriptPath, `process.stdout.write(${JSON.stringify(response)});\n`, "utf8");
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

function configWithPolicy(scriptPath: string): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec",
          command: process.execPath,
          args: [scriptPath],
          allowInsecurePath: true,
        },
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("collectInstallPolicyHealthLines", () => {
  it("returns no lines when install policy is disabled", async () => {
    await expect(collectInstallPolicyHealthLines({})).resolves.toEqual([]);
  });

  it("reports static availability without running the command by default", async () => {
    const dir = await makeTempDir();
    const scriptPath = await writePolicyScript(
      dir,
      JSON.stringify({ protocolVersion: 1, decision: "block", reason: "probe blocked" }),
    );

    const lines = await collectInstallPolicyHealthLines(configWithPolicy(scriptPath));

    expect(lines.join("\n")).toContain("Install policy enabled for: skill, plugin");
    expect(lines.join("\n")).toContain("Static checks passed");
    expect(lines.join("\n")).not.toContain("probe blocked");
  });

  it("runs the synthetic probe in deep mode", async () => {
    const dir = await makeTempDir();
    const scriptPath = await writePolicyScript(
      dir,
      JSON.stringify({ protocolVersion: 1, decision: "allow" }),
    );

    const lines = await collectInstallPolicyHealthLines(configWithPolicy(scriptPath), {
      deep: true,
    });

    expect(lines.join("\n")).toContain("Deep probe allowed the synthetic install request");
  });

  it("reports unavailable enabled policy as fail-closed", async () => {
    const lines = await collectInstallPolicyHealthLines({
      security: {
        installPolicy: {
          enabled: true,
        },
      },
    });

    expect(lines.join("\n")).toContain("security.installPolicy.exec is not configured");
    expect(lines.join("\n")).toContain("will fail closed");
  });
});
