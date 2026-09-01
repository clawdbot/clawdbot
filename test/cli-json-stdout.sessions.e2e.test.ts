import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

async function seedTrajectorySession(tempHome: string, sessionKey: string) {
  const stateDir = path.join(tempHome, "isolated-state");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete env.OPENCLAW_HOME;
  const [{ upsertSessionEntryCore }, { closeOpenClawAgentDatabaseByPath }] = await Promise.all([
    import("../src/config/sessions/session-accessor.js"),
    import("../src/state/openclaw-agent-db.js"),
  ]);
  await upsertSessionEntryCore(
    { agentId: "main", env, sessionKey },
    { sessionId: "trajectory-process-session", updatedAt: 1 },
  );
  closeOpenClawAgentDatabaseByPath(
    path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
  );
}

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "bare list active filter in human mode",
      args: ["sessions", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      human: true,
    },
    {
      name: "bare list limit in human mode through forced Commander",
      args: ["sessions", "--limit", "0"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      human: true,
      commander: true,
    },
    {
      name: "routed bare list active filter with JSON before its option",
      args: ["sessions", "--json", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "routed bare list limit with JSON after its option",
      args: ["sessions", "--limit", "0", "--json"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
    },
    {
      name: "Commander bare list active filter with JSON after its option",
      args: ["sessions", "--active", "0", "--json"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      commander: true,
    },
    {
      name: "Commander bare list limit with JSON before its option",
      args: ["sessions", "--json", "--limit", "0"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      commander: true,
    },
    {
      name: "list alias active filter with inherited parent JSON",
      args: ["sessions", "--json", "list", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "list alias limit with leaf JSON",
      args: ["sessions", "list", "--limit", "0", "--json"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
    },
    {
      name: "bare list active filter before an invalid limit",
      args: ["sessions", "--json", "--limit", "0", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "routed bare list active filter through dual-TTY finalization",
      args: ["sessions", "--json", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      tty: true,
    },
    {
      name: "Commander bare list limit through dual-TTY finalization",
      args: ["sessions", "--limit", "0", "--json"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      commander: true,
      tty: true,
    },
    {
      name: "cleanup with an inherited filter in human mode",
      args: ["sessions", "--active", "5", "cleanup"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
      human: true,
    },
    {
      name: "cleanup inherited filter with leaf JSON",
      args: ["sessions", "--active", "5", "cleanup", "--json"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
    },
    {
      name: "cleanup inherited limit with parent JSON",
      args: ["sessions", "--json", "--limit", "1", "cleanup"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --limit; session-list filters cannot scope session maintenance.",
    },
    {
      name: "trajectory export inherited all-agent scope",
      args: [
        "sessions",
        "--all-agents",
        "export-trajectory",
        "--session-key",
        "agent:main:main",
        "--json",
      ],
      message:
        "`sessions export-trajectory` does not support the parent `sessions` option --all-agents; trajectory export targets one session and cannot apply session-list filters.",
    },
    {
      name: "trajectory export missing session key in human mode",
      args: ["sessions", "export-trajectory"],
      message: "--session-key is required. Run openclaw sessions to choose a session.",
      human: true,
    },
    {
      name: "trajectory export missing session key with leaf JSON",
      args: ["sessions", "export-trajectory", "--json"],
      message: "--session-key is required. Run openclaw sessions to choose a session.",
    },
    {
      name: "trajectory export missing session key with parent JSON through forced Commander",
      args: ["sessions", "--json", "export-trajectory"],
      message: "--session-key is required. Run openclaw sessions to choose a session.",
      commander: true,
    },
    {
      name: "trajectory export malformed encoded request",
      args: [
        "sessions",
        "export-trajectory",
        "--request-json-base64",
        Buffer.from("not json", "utf8").toString("base64url"),
        "--json",
      ],
      message:
        "Failed to decode trajectory export request: Encoded trajectory export request is invalid JSON",
    },
    {
      name: "trajectory export noncanonical encoded request with parent JSON",
      args: [
        "sessions",
        "--json",
        "export-trajectory",
        "--request-json-base64",
        ` ${Buffer.from(JSON.stringify({ sessionKey: "agent:main:test" })).toString("base64url")} `,
      ],
      message:
        "Failed to decode trajectory export request: Encoded trajectory export request is invalid",
    },
    {
      name: "trajectory export blank explicit agent",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:test",
        "--agent",
        "",
        "--json",
      ],
      message: "--agent must not be blank",
    },
    {
      name: "trajectory export unconfigured explicit agent",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:test",
        "--agent",
        "unknown-agent",
        "--json",
      ],
      message:
        'Unknown agent id "unknown-agent". Run openclaw agents list to see configured agents.',
    },
    {
      name: "trajectory export missing session through dual-TTY finalization",
      args: ["sessions", "export-trajectory", "--session-key", "agent:main:missing", "--json"],
      message:
        "Session not found: agent:main:missing. Run openclaw sessions to see available sessions.",
      tty: true,
    },
    {
      name: "trajectory export invalid explicit store",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:trajectory-process",
        "--store",
        "$MISSING_STORE",
        "--json",
      ],
      message:
        "Session store target does not exist: $MISSING_STORE. Pass a selector whose resolved SQLite target exists.",
    },
    {
      name: "trajectory exporter operational failure",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:trajectory-process",
        "--workspace",
        "$TRAJECTORY_WORKSPACE",
        "--json",
      ],
      message: "Failed to export trajectory: injected trajectory exporter failure",
      exporterFailure: true,
    },
    {
      name: "archive inherited store with leaf JSON",
      args: ["sessions", "--store", "/tmp/other.sqlite", "archive", "agent:main:test", "--json"],
      message:
        "`sessions archive` does not support the parent `sessions` option --store; the gateway resolves target stores from each key and --agent.",
    },
    {
      name: "archive invalid timeout with parent JSON",
      args: ["sessions", "--json", "archive", "agent:main:test", "--timeout", "0"],
      message: "--timeout must be a positive integer (milliseconds).",
    },
    {
      name: "delete inherited all-agent scope",
      args: ["sessions", "--all-agents", "delete", "agent:main:test", "--yes", "--json"],
      message:
        "`sessions delete` does not support the parent `sessions` option --all-agents; the gateway resolves target stores from each key and --agent.",
    },
    {
      name: "delete invalid timeout with leaf JSON",
      args: ["sessions", "delete", "agent:main:test", "--timeout", "nope", "--yes", "--json"],
      message: "--timeout must be a positive integer (milliseconds).",
    },
    {
      name: "compact inherited all-agent scope",
      args: ["sessions", "--all-agents", "compact", "agent:main:test", "--json"],
      message:
        "`sessions compact` does not support the parent `sessions` option --all-agents; the gateway resolves the target store from <key> and --agent.",
    },
    {
      name: "compact invalid max-lines with leaf JSON",
      args: ["sessions", "compact", "agent:main:test", "--max-lines", "0", "--json"],
      message: "--max-lines must be a positive integer.",
    },
    {
      name: "compact invalid timeout with parent JSON",
      args: ["sessions", "--json", "compact", "agent:main:test", "--timeout", "0"],
      message: "--timeout must be a positive integer (milliseconds).",
    },
    {
      name: "human-only tail rejecting inherited JSON",
      args: ["sessions", "--json", "tail"],
      message:
        "`sessions tail` does not support the parent `sessions` option --json; trajectory tail emits human-readable progress and selects sessions separately.",
    },
    {
      name: "cleanup inherited filter through forced Commander",
      args: ["sessions", "--active", "5", "cleanup", "--json"],
      message:
        "`sessions cleanup` does not support the parent `sessions` option --active; session-list filters cannot scope session maintenance.",
      commander: true,
    },
    {
      name: "compact invalid max-lines through dual-TTY finalization",
      args: ["sessions", "compact", "agent:main:test", "--max-lines", "0", "--json"],
      message: "--max-lines must be a positive integer.",
      tty: true,
    },
  ])("renders sessions list and registration validation failures for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        if ("exporterFailure" in testCase) {
          await seedTrajectorySession(tempHome, "agent:main:trajectory-process");
        }
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            'globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            ...("exporterFailure" in testCase
              ? [
                  'import fs from "node:fs/promises";',
                  "const originalRealpath = fs.realpath;",
                  `fs.realpath = async (target, ...args) => { if (target === ${JSON.stringify(tempHome)}) { throw new Error("injected trajectory exporter failure"); } return originalRealpath(target, ...args); };`,
                ]
              : []),
            ...("tty" in testCase
              ? [
                  'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
                  'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
                ]
              : []),
          ].join("\n"),
        ).toString("base64");
        const missingStore = path.join(tempHome, "missing-store.sqlite");
        const args = testCase.args.map((arg) =>
          arg === "$TRAJECTORY_WORKSPACE"
            ? tempHome
            : arg === "$MISSING_STORE"
              ? missingStore
              : arg,
        );
        const message = testCase.message.replace("$MISSING_STORE", missingStore);
        const result = runBuiltCli(tempHome, args, {
          NODE_OPTIONS: `--import=data:text/javascript;base64,${preload}`,
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_GATEWAY_PORT: "29791",
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
        });

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toContain("\u001B");
        expect(result.stdout, result.stderr).not.toContain("\u0007");
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
          });
        }
        expect(result.stderr).toContain(message);
        expect(result.stderr.split(message)).toHaveLength(2);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-sessions-registration-json-failure-e2e-" },
    );
  });

  it.each([
    { name: "direct JSON export", encoded: false, json: true },
    { name: "encoded request precedence with plain output", encoded: true, json: false },
  ])("preserves successful trajectory $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const sessionKey = "agent:main:trajectory-process";
        await seedTrajectorySession(tempHome, sessionKey);
        const output = testCase.encoded ? "encoded-export" : "direct-export";
        const args = [
          "sessions",
          "export-trajectory",
          "--session-key",
          testCase.encoded ? "agent:main:missing" : sessionKey,
          "--output",
          "direct-export",
          "--workspace",
          tempHome,
        ];
        if (testCase.encoded) {
          args.push(
            "--request-json-base64",
            Buffer.from(JSON.stringify({ sessionKey, output }), "utf8").toString("base64url"),
          );
        }
        if (testCase.json) {
          args.push("--json");
        }

        const result = runBuiltCli(tempHome, args, {
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_GATEWAY_PORT: "29791",
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
        });

        expect(result.status, result.stderr).toBe(0);
        if (testCase.json) {
          expect(JSON.parse(result.stdout)).toMatchObject({
            displayPath: `.openclaw/trajectory-exports/${output}`,
            sessionId: "trajectory-process-session",
          });
        } else {
          expect(result.stdout).toContain("✅ Trajectory exported!");
          expect(result.stdout).toContain(`.openclaw/trajectory-exports/${output}`);
          expect(result.stdout).toContain("trajectory-process-session");
        }
        await expect(
          fs.access(
            path.join(tempHome, ".openclaw", "trajectory-exports", output, "manifest.json"),
          ),
        ).resolves.toBeUndefined();
      },
      { prefix: "openclaw-trajectory-success-e2e-" },
    );
  });
});
