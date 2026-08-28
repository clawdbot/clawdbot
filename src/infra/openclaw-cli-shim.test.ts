import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExecTool } from "../agents/bash-tools.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureEnv } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveCurrentOpenClawCliInvocation } from "./openclaw-cli-invocation.js";
import { clearGatewayAgentCliShim, prepareGatewayAgentCliShim } from "./openclaw-cli-shim.js";

const requireFromHere = createRequire(import.meta.url);
const envSnapshot = captureEnv(["OPENCLAW_EXEC_SHELL_SNAPSHOT", "OPENCLAW_PROFILE", "PATH"]);

afterEach(() => {
  clearGatewayAgentCliShim();
  envSnapshot.restore();
});

function readExecText(result: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>) {
  return result.content.find((entry) => entry.type === "text")?.text?.trim() ?? "";
}

describe.skipIf(process.platform === "win32")("Gateway agent CLI shim", () => {
  it("resolves source-mode dependencies without changing the caller cwd", async () => {
    await withTempDir("openclaw-agent-cli-shim-cwd-", async (root) => {
      const outsideCwdPath = path.join(root, "outside");
      const entryPath = path.join(root, "gateway-entry.ts");
      const stateDir = path.join(root, "state");
      await fs.mkdir(outsideCwdPath);
      const outsideCwd = await fs.realpath(outsideCwdPath);
      await fs.writeFile(
        entryPath,
        'import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";\n' +
          'console.log(JSON.stringify({ cwd: process.cwd(), source: normalizeUniqueStringEntries(["gateway"])[0] }));\n',
      );

      const repoRoot = process.cwd();
      const sourceEntry = path.join(repoRoot, "src", "entry.ts");
      const sourceInvocation = resolveCurrentOpenClawCliInvocation([], {
        argv1: sourceEntry,
        cwd: repoRoot,
        execArgv: ["--import", requireFromHere.resolve("tsx")],
        execPath: process.execPath,
      });
      expect(sourceInvocation.tsxConfigPath).toBe(path.join(repoRoot, "tsconfig.json"));
      const invocation = {
        ...sourceInvocation,
        args: sourceInvocation.args.map((arg) => (arg === sourceEntry ? entryPath : arg)),
      };

      await prepareGatewayAgentCliShim({
        invocation,
        stateDir,
      });

      process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = "0";
      const execConfig = resolveExecToolConfig({ cfg: {} });
      const tool = createExecTool({
        ...execConfig,
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: outsideCwd,
        notifyOnExit: false,
      });
      const result = await tool.execute("gateway-cli-cwd-probe", {
        command: "openclaw",
        yieldMs: 120_000,
      });

      expect(JSON.parse(readExecText(result))).toEqual({ cwd: outsideCwd, source: "gateway" });
    });
  });

  it.each([
    { profile: "work", expectedArgs: ["--profile", "work", "probe"] },
    { profile: undefined, expectedArgs: ["probe"] },
  ])("pins the running CLI before configured PATH entries (profile=$profile)", async (testCase) => {
    await withTempDir("openclaw-agent-cli-shim-", async (root) => {
      const entryPath = path.join(root, "gateway-entry.mjs");
      const staleBinDir = path.join(root, "stale-bin");
      const staleCliPath = path.join(staleBinDir, "openclaw");
      const stateDir = path.join(root, "state");
      await fs.mkdir(staleBinDir, { recursive: true });
      await fs.writeFile(
        entryPath,
        'console.log(JSON.stringify({ source: "gateway", args: process.argv.slice(2), pathHead: process.env.PATH?.split(":")[0] }));\n',
      );
      await fs.writeFile(staleCliPath, "#!/bin/sh\nprintf '%s\\n' '{\"source\":\"stale\"}'\n", {
        mode: 0o700,
      });

      await prepareGatewayAgentCliShim({
        env: testCase.profile ? { OPENCLAW_PROFILE: testCase.profile } : {},
        invocation: { command: process.execPath, args: [entryPath], cwd: root },
        stateDir,
      });
      const shimBinDir = path.join(stateDir, "tmp", "agent-cli");
      const config = {
        tools: { exec: { pathPrepend: [staleBinDir] } },
      } satisfies OpenClawConfig;
      const execConfig = resolveExecToolConfig({ cfg: config });
      expect(execConfig.pathPrepend?.slice(0, 2)).toEqual([shimBinDir, staleBinDir]);

      process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = "0";
      process.env.PATH = `${staleBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
      delete process.env.OPENCLAW_PROFILE;
      const tool = createExecTool({
        ...execConfig,
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: root,
        notifyOnExit: false,
      });
      const result = await tool.execute("gateway-cli-version-probe", {
        command: "openclaw probe",
        yieldMs: 120_000,
      });
      expect(JSON.parse(readExecText(result))).toEqual({
        source: "gateway",
        args: testCase.expectedArgs,
        pathHead: shimBinDir,
      });
    });
  });
});

it("renders a Windows PATH launcher for the running CLI", async () => {
  await withTempDir("openclaw-agent-cli-shim-win-", async (root) => {
    await prepareGatewayAgentCliShim({
      env: { OPENCLAW_PROFILE: "work" },
      invocation: {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: ["C:\\OpenClaw\\dist\\index.js"],
        cwd: "C:\\OpenClaw",
        tsxConfigPath: "C:\\OpenClaw\\tsconfig.json",
      },
      platform: "win32",
      stateDir: root,
    });

    const executablePath = path.join(root, "tmp", "agent-cli", "openclaw.cmd");
    expect(await fs.readFile(executablePath, "utf8")).toBe(
      '@echo off\r\nset "TSX_TSCONFIG_PATH=C:\\OpenClaw\\tsconfig.json"\r\n"C:\\Program Files\\nodejs\\node.exe" C:\\OpenClaw\\dist\\index.js --profile work %*\r\n',
    );
  });
});
