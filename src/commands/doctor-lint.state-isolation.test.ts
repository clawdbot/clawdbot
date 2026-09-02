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
import { requestDevicePairing } from "../infra/device-pairing.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  resolveDoctorContributionHealthChecks: vi.fn(),
  pairingReadState: vi.fn(),
  sqliteOpen: vi.fn(),
}));

vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.resolveDoctorContributionHealthChecks,
}));
vi.mock("../infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing.js")>();
  return {
    ...actual,
    listDevicePairingReadOnly(baseDir?: string) {
      mocks.pairingReadState(baseDir ?? process.env.OPENCLAW_STATE_DIR);
      return actual.listDevicePairingReadOnly(baseDir);
    },
  };
});
vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase(...args: Parameters<typeof actual.openNodeSqliteDatabase>) {
      mocks.sqliteOpen(args[0], args[1]?.readOnly === true);
      return actual.openNodeSqliteDatabase(...args);
    },
  };
});

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
    mocks.pairingReadState.mockClear();
    mocks.sqliteOpen.mockClear();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    restoreEnv(originalEnv);
  });

  it.each([
    { label: "--all", selection: "all", profile: undefined, isolated: true },
    { label: "mixed --only with profile", selection: "mixed", profile: "work", isolated: true },
    { label: "--only with profile", selection: "only", profile: "work", isolated: false },
    { label: "default selection", selection: "default", profile: undefined, isolated: false },
  ] as const)("keeps retired device-auth detection scoped for $label", async (entry) => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-doctor-lint-device-auth-",
        env: { OPENCLAW_TEST_FAST: "1", OPENCLAW_PROFILE: entry.profile },
      },
      async (state) => {
        await state.writeConfig({
          gateway: { mode: "local" },
          memory: { search: { enabled: false } },
        });
        const pending = await requestDevicePairing(
          {
            deviceId: "snapshot-device",
            publicKey: "synthetic-public-key",
            role: "operator",
            scopes: ["operator.read"],
          },
          state.stateDir,
        );
        const sourcePath = await state.writeText("identity/device-auth.json", "legacy-file-marker");
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        closeOpenClawStateDatabaseByPath(databasePath);
        const before = snapshotSqliteFamily(databasePath);
        const actual = await vi.importActual<
          typeof import("../flows/doctor-health-contributions.js")
        >("../flows/doctor-health-contributions.js");
        const pairingCheck = (await actual.resolveDoctorContributionHealthChecks()).find(
          (check) => check.id === "core/doctor/device-pairing",
        );
        if (!pairingCheck) {
          throw new Error("device-pairing contribution is missing");
        }
        // Keep the real contribution and lint state-mode selection; unrelated core
        // checks must not turn this local state-boundary test into a service audit.
        mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([pairingCheck]);
        mocks.pairingReadState.mockClear();
        mocks.sqliteOpen.mockClear();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          const selection =
            entry.selection === "all"
              ? { includeAllChecks: true }
              : entry.selection === "default"
                ? {}
                : {
                    onlyIds: [
                      "core/doctor/device-pairing",
                      ...(entry.selection === "mixed"
                        ? ["memory-core/managed-local-embedding-setup"]
                        : []),
                    ],
                  };
          const exitCode = await runDoctorLintCli(runtime, { json: true, ...selection });
          const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          if (entry.selection === "default") {
            expect(exitCode).toBe(0);
            expect(payload.findings).toEqual([]);
            expect(mocks.pairingReadState).not.toHaveBeenCalled();
          } else {
            expect(exitCode).toBe(1);
            expect(payload.findings).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  requirement: "device-auth-store-legacy-file",
                  message: expect.stringContaining(sourcePath),
                  fixHint: expect.stringContaining(
                    entry.profile
                      ? "openclaw --profile work doctor --fix"
                      : "openclaw doctor --fix",
                  ),
                }),
                expect.objectContaining({
                  requirement: "first-time",
                  target: `snapshot-device:${pending.request.requestId}`,
                }),
              ]),
            );
            expect(mocks.pairingReadState).toHaveBeenCalledOnce();
            const inspectedState = mocks.pairingReadState.mock.calls[0]?.[0];
            if (entry.isolated) {
              expect(inspectedState).not.toBe(state.stateDir);
              expect(mocks.sqliteOpen).toHaveBeenCalled();
              expect(mocks.sqliteOpen.mock.calls.every(([file]) => file !== databasePath)).toBe(
                true,
              );
            } else {
              expect(inspectedState).toBe(state.stateDir);
            }
          }
          expect(fs.readFileSync(sourcePath, "utf8")).toBe("legacy-file-marker");
          const after = snapshotSqliteFamily(databasePath);
          if (entry.isolated) {
            expect(after).toEqual(before);
          } else {
            // Ordinary read-only metadata reads may create WAL/SHM coordination files.
            // Unchanged database bytes plus an empty WAL rule out durable row changes.
            expect(after[0]).toEqual(before[0]);
            for (const artifact of after.slice(1)) {
              if (artifact.path === `${databasePath}-wal`) {
                expect(fs.statSync(artifact.path).size).toBe(0);
              } else {
                expect(artifact.path).toBe(`${databasePath}-shm`);
              }
            }
            expect(
              mocks.sqliteOpen.mock.calls.every(
                ([file, readOnly]) => file !== databasePath || readOnly === true,
              ),
            ).toBe(true);
          }
          expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
          expect(process.env.OPENCLAW_PROFILE).toBe(entry.profile);
        } finally {
          stdout.mockRestore();
        }
      },
    );
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
