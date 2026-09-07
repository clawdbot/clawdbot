import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { shellQuote } from "../../scripts/e2e/parallels/host-command.ts";
import {
  ensureSmokeGuestRuntime,
  installSmokeRuntimeCompanions,
} from "../../scripts/e2e/parallels/smoke-common.ts";

describe("Parallels runtime companion setup", () => {
  it.each(["anthropic", "minimax"] as const)(
    "does not install unrelated companions for %s",
    async (provider) => {
      const readCli = vi.fn();
      const installCli = vi.fn();
      await installSmokeRuntimeCompanions({ provider, readCli, installCli });
      expect(readCli).not.toHaveBeenCalled();
      expect(installCli).not.toHaveBeenCalled();
    },
  );

  it("leaves the shipped pre-consent CLI to provision its own companion version", async () => {
    const readCli = vi.fn((args: string[]) => {
      expect(args).toEqual(["plugins", "install", "--help"]);
      return "Usage: openclaw plugins install [options] <spec>\n  --pin  Pin resolved version\n";
    });
    const installCli = vi.fn();
    await installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli });
    expect(readCli).toHaveBeenCalledTimes(1);
    expect(installCli).not.toHaveBeenCalled();
  });

  it.each(["2026.8.1", "2026.8.1-beta.2"])(
    "pins only the reviewed runtime companion to installed candidate %s",
    async (version) => {
      const readCli = vi.fn((args: string[]) =>
        args[0] === "--version"
          ? `OpenClaw ${version} (abcdef0)\n`
          : "Options:\n  --accept-capabilities  Accept declared capabilities\n",
      );
      const installCli = vi.fn().mockResolvedValue(undefined);
      await installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli });
      expect(installCli).toHaveBeenCalledExactlyOnceWith([
        "plugins",
        "install",
        `npm:@openclaw/codex@${version}`,
        "--pin",
        "--accept-capabilities",
      ]);
    },
  );

  it("propagates companion installation failures before onboarding can continue", async () => {
    const error = new Error("existing plugin install must not be overwritten");
    const readCli = (args: string[]) =>
      args[0] === "--version" ? "OpenClaw 2026.8.1" : "  --accept-capabilities  Accept\n";
    const installCli = vi.fn().mockRejectedValue(error);
    await expect(
      installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli }),
    ).rejects.toBe(error);
  });

  it("refuses an unidentifiable core version instead of installing a moving tag", async () => {
    const readCli = (args: string[]) =>
      args[0] === "--version" ? "unknown" : "  --accept-capabilities  Accept\n";
    const installCli = vi.fn();
    await expect(
      installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli }),
    ).rejects.toThrow("could not resolve installed OpenClaw version");
    expect(installCli).not.toHaveBeenCalled();
  });
});

describe("Parallels Linux runtime prerequisites", () => {
  it.each([
    { nodeVersion: "24.18.0", npmExit: 0, gitExit: 0, bootstrap: false },
    { nodeVersion: "26.1.0", npmExit: 0, gitExit: 0, bootstrap: false },
    { nodeVersion: "26.0.0", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "24.14.1", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "23.11.0", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "24.18.0", npmExit: 127, gitExit: 0, bootstrap: true },
    { nodeVersion: "24.18.0", npmExit: 0, gitExit: 127, bootstrap: true },
  ])("checks usable Node/npm/Git before bootstrap: %j", (scenario) => {
    const bootstrap = vi.fn();
    ensureSmokeGuestRuntime({
      runShell: (script) => {
        const nodeRunner = shellQuote(process.execPath);
        const nodeCheckRunner = shellQuote(
          'Object.defineProperty(process.versions, "node", { value: process.env.OPENCLAW_TEST_NODE_RELEASE }); eval(process.argv[1]);',
        );
        return execFileSync(
          "bash",
          [
            "-c",
            `node() { ${nodeRunner} -e ${nodeCheckRunner} "$2"; }
npm() { return ${scenario.npmExit}; }
git() { return ${scenario.gitExit}; }
${script}`,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, OPENCLAW_TEST_NODE_RELEASE: scenario.nodeVersion },
            timeout: 10_000,
          },
        );
      },
      bootstrap,
    });
    expect(bootstrap).toHaveBeenCalledTimes(scenario.bootstrap ? 1 : 0);
  });
});
