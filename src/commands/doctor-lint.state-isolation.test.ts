import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "../agents/mcp-oauth-provider.js";
import { resolveMcpOAuthAccessToken } from "../agents/mcp-oauth.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  resolveDoctorContributionHealthChecks: vi.fn(),
}));

vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.resolveDoctorContributionHealthChecks,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const originalEnv = {
  HOME: process.env.HOME,
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
};

describe("doctor lint state isolation", () => {
  beforeEach(() => {
    clearHealthChecksForTest();
    mocks.resolveDoctorContributionHealthChecks.mockReset();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    restoreEnv(originalEnv);
  });

  it("keeps runtime schema OAuth inspection off the writable source state", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-oauth-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const serverUrl = "https://mcp.example.test/rpc";
    const identity = operatorMcpOAuthIdentity("oauth-proof", serverUrl);
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    await createMcpOAuthClientProvider({ identity }).saveTokens({
      access_token: "stored-inspection-token-not-real",
      token_type: "Bearer",
      expires_in: 3600,
    });
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    closeOpenClawStateDatabaseByPath(databasePath);
    const lock = new DatabaseSync(databasePath);
    lock.exec("BEGIN IMMEDIATE");
    const before = snapshotSqliteFamily(databasePath);
    mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
      {
        id: "core/doctor/runtime-tool-schemas",
        kind: "core",
        description: "checks OAuth state ownership",
        async detect() {
          const token = await resolveMcpOAuthAccessToken({
            identity,
            acceptUnknownExpiry: true,
            signal: AbortSignal.timeout(250),
          });
          expect(token).toBe("stored-inspection-token-not-real");
          return [];
        },
      },
    ]);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          onlyIds: ["core/doctor/runtime-tool-schemas"],
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: true,
        checksRun: 1,
        findings: [],
      });
      expect(snapshotSqliteFamily(databasePath)).toEqual(before);
    } finally {
      stdout.mockRestore();
      lock.exec("ROLLBACK");
      lock.close();
      closeOpenClawStateDatabaseByPath(databasePath);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

function snapshotSqliteFamily(databasePath: string): Array<{ path: string; sha256: string }> {
  return ["", "-journal", "-shm", "-wal"]
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      path: candidate,
      sha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
    }));
}

function restoreEnv(values: typeof originalEnv): void {
  if (values.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = values.HOME;
  }
  if (values.OPENCLAW_CONFIG_PATH === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = values.OPENCLAW_CONFIG_PATH;
  }
  if (values.OPENCLAW_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = values.OPENCLAW_STATE_DIR;
  }
}
