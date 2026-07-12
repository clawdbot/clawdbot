// Upgrade Survivor Assertions tests cover upgrade survivor assertions script behavior.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const ASSERTIONS_PATH = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMigratedSessionState(stateDir: string): void {
  const agentSessionsDir = join(stateDir, "agents", "main", "sessions");
  const agentDbDir = join(stateDir, "agents", "main", "agent");
  mkdirSync(agentSessionsDir, { recursive: true });
  mkdirSync(agentDbDir, { recursive: true });

  const db = new DatabaseSync(join(agentDbDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_routes (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE session_entries (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);
    const insertSession = db.prepare(`
      INSERT INTO sessions (session_id, session_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertRoute = db.prepare(`
      INSERT INTO session_routes (session_key, session_id, updated_at)
      VALUES (?, ?, ?)
    `);
    const insertEntry = db.prepare(`
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertTranscript = db.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const migratedSessions = [
      {
        entry: {
          skillsSnapshot: {
            prompt: "legacy prompt survives as metadata",
          },
        },
        sessionId: "upgrade-main-session",
        sessionKey: "agent:main:main",
      },
      {
        entry: {},
        sessionId: "upgrade-direct-session",
        sessionKey: "agent:main:+15551234567",
      },
      {
        entry: {},
        sessionId: "upgrade-group-session",
        sessionKey: "agent:main:slack:channel:cupgrade",
      },
    ];
    for (const { entry, sessionId, sessionKey } of migratedSessions) {
      insertSession.run(sessionId, sessionKey, 1710000000000, 1710000000000);
      insertRoute.run(sessionKey, sessionId, 1710000000000);
      insertEntry.run(sessionKey, sessionId, JSON.stringify(entry), 1710000000000);
      insertTranscript.run(
        sessionId,
        1,
        JSON.stringify({ type: "session", id: sessionId }),
        1710000000000,
      );
    }
  } finally {
    db.close();
  }
}

function assertConfiguredPluginState(params: { installPath?: string } = {}): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-"));
  try {
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    const matrixInstallDir = params.installPath ?? join(stateDir, "extensions", "matrix");
    mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    mkdirSync(matrixInstallDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "IDENTITY.md"), "# survivor\n");
    writeJson(join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
      id: "legacy-session",
    });
    writeMigratedSessionState(stateDir);
    writeJson(join(matrixInstallDir, "package.json"), {
      name: "@openclaw/matrix",
    });
    writeJson(join(stateDir, "plugins", "installs.json"), {
      installRecords: {
        matrix: {
          source: "clawhub",
          spec: "clawhub:@openclaw/matrix",
          installPath: matrixInstallDir,
          clawhubPackage: "@openclaw/matrix",
          clawhubChannel: "official",
          artifactKind: "npm-pack",
        },
      },
      plugins: [{ pluginId: "matrix", enabled: true }],
    });
    const coveragePath = join(root, "coverage.json");
    writeJson(coveragePath, {
      acceptedIntents: ["configured-plugin-installs"],
      skippedIntents: [],
    });

    execFileSync(process.execPath, [ASSERTIONS_PATH, "assert-state"], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_WORKSPACE_DIR: workspace,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "configured-plugin-installs",
      },
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("upgrade survivor assertions", () => {
  it("accepts the ACPX OpenClaw tools bridge scenario during seed", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-acpx-"));
    try {
      const stateDir = join(root, "state");
      const workspace = join(root, "workspace");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });

      execFileSync(process.execPath, [ASSERTIONS_PATH, "seed"], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_WORKSPACE_DIR: workspace,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "acpx-openclaw-tools-bridge",
        },
        stdio: "pipe",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("asserts the ACPX OpenClaw tools bridge config survived", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-acpx-config-"));
    try {
      const configPath = join(root, "openclaw.json");
      const coveragePath = join(root, "coverage.json");
      writeJson(configPath, {
        plugins: {
          allow: ["acpx"],
          entries: {
            acpx: {
              enabled: true,
              config: {
                openClawToolsMcpBridge: true,
              },
            },
          },
        },
      });
      writeJson(coveragePath, {
        acceptedIntents: ["acpx-openclaw-tools-bridge"],
        skippedIntents: [],
      });

      execFileSync(process.execPath, [ASSERTIONS_PATH, "assert-config"], {
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "acpx-openclaw-tools-bridge",
        },
        stdio: "pipe",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts official ClawHub npm-pack installs for configured external plugins", () => {
    expect(() => assertConfiguredPluginState()).not.toThrow();
  });

  it("rejects ClawHub npm-pack installs outside the managed extensions root", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-outside-"));
    try {
      expect(() =>
        assertConfiguredPluginState({ installPath: join(root, "outside-matrix") }),
      ).toThrow(/managed extensions root/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
