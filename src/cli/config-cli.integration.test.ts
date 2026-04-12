import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { runConfigSet } from "./config-cli.js";

function createTestRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    runtime: {
      log: (...args: unknown[]) => logs.push(args.map((arg) => String(arg)).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map((arg) => String(arg)).join(" ")),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    },
  };
}

function createExecDryRunBatch(params: { markerPath: string }) {
  const response = JSON.stringify({
    protocolVersion: 1,
    values: {
      dryrun_id: "ok",
    },
  });
  const script = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(params.markerPath)}, "dryrun\\n", "utf8");`,
    `process.stdout.write(${JSON.stringify(response)});`,
  ].join("");
  return [
    {
      path: "secrets.providers.runner",
      provider: {
        source: "exec",
        command: process.execPath,
        args: ["-e", script],
        allowInsecurePath: true,
        timeoutMs: 60_000,
        noOutputTimeoutMs: 60_000,
      },
    },
    {
      path: "channels.discord.token",
      ref: {
        source: "exec",
        provider: "runner",
        id: "dryrun_id",
      },
    },
  ];
}

async function withExecDryRunConfigHarness(
  prefix: string,
  run: (params: {
    batchPath: string;
    configPath: string;
    markerPath: string;
    runtime: ReturnType<typeof createTestRuntime>;
  }) => Promise<void>,
) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(tempDir, "openclaw.json");
  const batchPath = path.join(tempDir, "batch.json");
  const markerPath = path.join(tempDir, "marker.txt");
  const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_TEST_FAST"]);
  try {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          gateway: { port: 18789 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.writeFileSync(
      batchPath,
      `${JSON.stringify(createExecDryRunBatch({ markerPath }), null, 2)}\n`,
      "utf8",
    );

    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    clearConfigCache();
    clearRuntimeConfigSnapshot();

    await run({
      batchPath,
      configPath,
      markerPath,
      runtime: createTestRuntime(),
    });
  } finally {
    envSnapshot.restore();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("config cli integration", () => {
  it("supports batch-file dry-run and then writes real config changes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-int-"));
    const configPath = path.join(tempDir, "openclaw.json");
    const batchPath = path.join(tempDir, "batch.json");
    const envSnapshot = captureEnv([
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_TEST_FAST",
      "DISCORD_BOT_TOKEN",
    ]);
    try {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            gateway: { port: 18789 },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      fs.writeFileSync(
        batchPath,
        `${JSON.stringify(
          [
            {
              path: "secrets.providers.default",
              provider: { source: "env" },
            },
            {
              path: "channels.discord.token",
              ref: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN",
              },
            },
          ],
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.env.OPENCLAW_TEST_FAST = "1";
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.DISCORD_BOT_TOKEN = "test-token";
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const runtime = createTestRuntime();
      const before = fs.readFileSync(configPath, "utf8");
      await runConfigSet({
        cliOptions: {
          batchFile: batchPath,
          dryRun: true,
        },
        runtime: runtime.runtime,
      });
      const afterDryRun = fs.readFileSync(configPath, "utf8");
      expect(afterDryRun).toBe(before);
      expect(runtime.errors).toEqual([]);
      expect(runtime.logs.some((line) => line.includes("Dry run successful: 2 update(s)"))).toBe(
        true,
      );

      await runConfigSet({
        cliOptions: {
          batchFile: batchPath,
        },
        runtime: runtime.runtime,
      });
      const afterWrite = JSON5.parse(fs.readFileSync(configPath, "utf8"));
      expect(afterWrite.secrets?.providers?.default).toEqual({
        source: "env",
      });
      expect(afterWrite.channels?.discord?.token).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      });
    } finally {
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps file unchanged when real-file dry-run fails and reports JSON error payload", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-int-fail-"));
    const configPath = path.join(tempDir, "openclaw.json");
    const envSnapshot = captureEnv([
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_TEST_FAST",
      "MISSING_TEST_SECRET",
    ]);
    try {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            gateway: { port: 18789 },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.env.OPENCLAW_TEST_FAST = "1";
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      delete process.env.MISSING_TEST_SECRET;
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const runtime = createTestRuntime();
      const before = fs.readFileSync(configPath, "utf8");
      await expect(
        runConfigSet({
          path: "channels.discord.token",
          cliOptions: {
            refProvider: "default",
            refSource: "env",
            refId: "MISSING_TEST_SECRET",
            dryRun: true,
            json: true,
          },
          runtime: runtime.runtime,
        }),
      ).rejects.toThrow("__exit__:1");
      const after = fs.readFileSync(configPath, "utf8");
      expect(after).toBe(before);
      expect(runtime.errors).toEqual([]);
      const raw = runtime.logs.at(-1);
      expect(raw).toBeTruthy();
      const payload = JSON.parse(raw ?? "{}") as {
        ok?: boolean;
        checks?: { schema?: boolean; resolvability?: boolean };
        errors?: Array<{ kind?: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.checks?.resolvability).toBe(true);
      expect(payload.errors?.some((entry) => entry.kind === "resolvability")).toBe(true);
      expect(payload.errors?.some((entry) => entry.ref?.includes("MISSING_TEST_SECRET"))).toBe(
        true,
      );
    } finally {
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips exec provider execution during dry-run by default", async () => {
    await withExecDryRunConfigHarness("openclaw-config-cli-int-exec-skip-", async (params) => {
      const before = fs.readFileSync(params.configPath, "utf8");
      await runConfigSet({
        cliOptions: {
          batchFile: params.batchPath,
          dryRun: true,
        },
        runtime: params.runtime.runtime,
      });
      const after = fs.readFileSync(params.configPath, "utf8");

      expect(after).toBe(before);
      expect(fs.existsSync(params.markerPath)).toBe(false);
      expect(
        params.runtime.logs.some((line) =>
          line.includes("Dry run note: skipped 1 exec SecretRef resolvability check(s)."),
        ),
      ).toBe(true);
    });
  });

  it("executes exec providers during dry-run when --allow-exec is set", async () => {
    await withExecDryRunConfigHarness("openclaw-config-cli-int-exec-allow-", async (params) => {
      const before = fs.readFileSync(params.configPath, "utf8");
      await runConfigSet({
        cliOptions: {
          batchFile: params.batchPath,
          dryRun: true,
          allowExec: true,
        },
        runtime: params.runtime.runtime,
      });
      const after = fs.readFileSync(params.configPath, "utf8");

      expect(after).toBe(before);
      expect(fs.existsSync(params.markerPath)).toBe(true);
      expect(
        params.runtime.logs.some((line) =>
          line.includes("Dry run note: skipped 1 exec SecretRef resolvability check(s)."),
        ),
      ).toBe(false);
    });
  });
});
