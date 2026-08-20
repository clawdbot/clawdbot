import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { clearConfigCache } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPolicyCli } from "./cli.js";

let workspaceDir: string;

async function writeFixture(path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf-8");
}

async function runPolicyCli(args: readonly string[]) {
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const consoleError = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    output.push(`${values.map(String).join(" ")}\n`);
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command().name("openclaw");
    registerPolicyCli(program);
    await program.parseAsync(["policy", ...args], { from: "user" });
    const lastOutput = output.at(-1) ?? "";
    const parsed = /^[{[]/.test(lastOutput.trimStart()) ? JSON.parse(lastOutput) : {};
    return { exitCode: process.exitCode ?? 0, parsed, output };
  } finally {
    process.exitCode = previousExitCode;
    stdout.mockRestore();
    stderr.mockRestore();
    consoleError.mockRestore();
  }
}

async function writeExplicitFleetConfig(): Promise<{
  readonly alphaWorkspace: string;
  readonly betaWorkspace: string;
}> {
  const alphaWorkspace = join(workspaceDir, "alpha-workspace");
  const betaWorkspace = join(workspaceDir, "beta-workspace");
  await Promise.all([
    fs.mkdir(alphaWorkspace, { recursive: true }),
    fs.mkdir(betaWorkspace, { recursive: true }),
  ]);
  const configPath = join(workspaceDir, "openclaw.jsonc");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await writeFixture(configPath, {
    agents: {
      ownership: "explicit",
      entries: {
        alpha: { workspace: alphaWorkspace },
        beta: { workspace: betaWorkspace },
      },
    },
    plugins: {
      entries: {
        policy: { enabled: true, config: { enabled: true, path: "policy.jsonc" } },
      },
    },
  });
  clearConfigCache();
  return { alphaWorkspace, betaWorkspace };
}

describe("policy CLI agent ownership", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-cli-owner-"));
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearConfigCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("checks the explicitly selected workspace without inspecting the first agent", async () => {
    const { alphaWorkspace, betaWorkspace } = await writeExplicitFleetConfig();
    await writeFixture(join(alphaWorkspace, "policy.jsonc"), "{");
    await writeFixture(join(betaWorkspace, "policy.jsonc"), {});

    const { exitCode, parsed } = await runPolicyCli(["check", "--agent", "beta", "--json"]);

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      attestation: { policy: { path: "policy.jsonc" } },
      findings: [],
    });
  });

  it("watches the explicitly selected workspace without inspecting the first agent", async () => {
    const { alphaWorkspace, betaWorkspace } = await writeExplicitFleetConfig();
    await writeFixture(join(alphaWorkspace, "policy.jsonc"), "{");
    await writeFixture(join(betaWorkspace, "policy.jsonc"), {});

    const { exitCode, parsed } = await runPolicyCli([
      "watch",
      "--agent",
      "beta",
      "--json",
      "--once",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      status: "clean",
      ok: true,
      attestation: { policy: { path: "policy.jsonc" } },
      findings: [],
    });
  });

  it("resolves a relative compare policy from the explicitly selected workspace", async () => {
    const { alphaWorkspace, betaWorkspace } = await writeExplicitFleetConfig();
    const baselinePath = join(workspaceDir, "baseline.policy.jsonc");
    await writeFixture(baselinePath, { network: { privateNetwork: { allow: false } } });
    await writeFixture(join(alphaWorkspace, "policy.jsonc"), {
      network: { privateNetwork: { allow: true } },
    });
    await writeFixture(join(betaWorkspace, "policy.jsonc"), {
      network: { privateNetwork: { allow: false } },
    });

    const { exitCode, parsed } = await runPolicyCli([
      "compare",
      "--agent",
      "beta",
      "--baseline",
      baselinePath,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({ ok: true, policyPath: "policy.jsonc", findings: [] });
  });

  it.each([
    {
      name: "check",
      args: ["check", "--json"],
      expected: "policy check has no explicit owner",
    },
    {
      name: "relative compare",
      args: ["compare", "--baseline", "baseline.policy.jsonc", "--json"],
      expected: "policy compare has no explicit owner",
    },
  ])("requires an owner for $name", async ({ args, expected }) => {
    await writeExplicitFleetConfig();
    await writeFixture(join(workspaceDir, "baseline.policy.jsonc"), {});

    const { exitCode, output } = await runPolicyCli(args);

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain(expected);
    expect(output.join("\n")).toContain("Pass --agent <id>.");
  });

  it.each([
    {
      name: "check without root options",
      args: ["check", "--agent", "ghost", "--json"],
      profile: "",
      container: "",
      hint: "openclaw agents list",
    },
    {
      name: "check with an active profile",
      args: ["check", "--agent", "ghost", "--json"],
      profile: "testprof",
      container: "",
      hint: "openclaw --profile testprof agents list",
    },
    {
      name: "watch with an active profile",
      args: ["watch", "--agent", "ghost", "--once", "--json"],
      profile: "testprof",
      container: "",
      hint: "openclaw --profile testprof agents list",
    },
    {
      name: "relative compare with an active container",
      args: ["compare", "--agent", "ghost", "--baseline", "baseline.policy.jsonc", "--json"],
      profile: "testprof",
      container: "testbox",
      hint: "openclaw --container testbox agents list",
    },
  ])("rejects an unknown explicit owner for $name with runnable guidance", async (testCase) => {
    await writeExplicitFleetConfig();
    vi.stubEnv("OPENCLAW_PROFILE", testCase.profile);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", testCase.container);

    const { exitCode, output } = await runPolicyCli(testCase.args);

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain(
      `Unknown agent id "ghost". Run ${testCase.hint} to see configured agents.`,
    );
  });
});
