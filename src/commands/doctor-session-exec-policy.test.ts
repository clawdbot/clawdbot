import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals-core.js";
import { maxAsk, minSecurity } from "../infra/exec-approvals-policy.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

let state: OpenClawTestState | undefined;

afterEach(async () => {
  note.mockClear();
  await state?.cleanup();
  state = undefined;
});

describe("doctor legacy session exec policy", () => {
  it.each<{
    name: string;
    cfg: OpenClawConfig;
    legacy: { execSecurity?: string; execAsk?: string };
    host?: SessionEntry["execHost"];
    sandbox?: SessionEntry["sandbox"];
    oldPolicy: { security: ExecSecurity; ask: ExecAsk };
    expected: SessionEntry["permissionMode"];
  }>([
    {
      name: "partial ask under global deny",
      cfg: { tools: { exec: { mode: "deny" } } },
      legacy: { execAsk: "off" },
      oldPolicy: { security: "deny", ask: "off" },
      expected: "read-only",
    },
    {
      name: "partial ask under agent deny overriding global full",
      cfg: {
        tools: { exec: { mode: "full" } },
        agents: { list: [{ id: "worker", tools: { exec: { mode: "deny" } } }] },
      },
      legacy: { execAsk: "off" },
      oldPolicy: { security: "deny", ask: "off" },
      expected: "read-only",
    },
    {
      name: "partial ask under allowlist config",
      cfg: { tools: { exec: { mode: "allowlist" } } },
      legacy: { execAsk: "off" },
      oldPolicy: { security: "allowlist", ask: "off" },
      expected: "guarded",
    },
    {
      name: "partial ask under full config",
      cfg: { tools: { exec: { mode: "full" } } },
      legacy: { execAsk: "off" },
      oldPolicy: { security: "full", ask: "off" },
      expected: undefined,
    },
    {
      name: "partial security inherits global ask always",
      cfg: { tools: { exec: { security: "full", ask: "always" } } },
      legacy: { execSecurity: "allowlist" },
      oldPolicy: { security: "allowlist", ask: "always" },
      expected: "read-only",
    },
    {
      name: "partial security inherits agent ask always",
      cfg: {
        tools: { exec: { mode: "full" } },
        agents: { list: [{ id: "worker", tools: { exec: { ask: "always" } } }] },
      },
      legacy: { execSecurity: "full" },
      oldPolicy: { security: "full", ask: "always" },
      expected: "read-only",
    },
    {
      name: "partial ask in a required sandbox",
      cfg: {},
      sandbox: "required",
      legacy: { execAsk: "off" },
      oldPolicy: { security: "deny", ask: "off" },
      expected: "read-only",
    },
    {
      name: "partial ask with unknown auto sandbox availability",
      cfg: {},
      host: "auto",
      legacy: { execAsk: "off" },
      oldPolicy: { security: "deny", ask: "off" },
      expected: "read-only",
    },
    {
      name: "partial ask with explicit gateway and no config policy",
      cfg: {},
      legacy: { execAsk: "off" },
      oldPolicy: { security: "full", ask: "off" },
      expected: undefined,
    },
  ])("does not broaden $name", async ({ cfg, legacy, host, sandbox, oldPolicy, expected }) => {
    state = await createOpenClawTestState({ prefix: "openclaw-doctor-exec-base-" });
    const scope = { agentId: "worker", env: state.env, sessionKey: "agent:worker:exec-policy" };
    await replaceSessionEntry(scope, {
      sessionId: "legacy-policy",
      updatedAt: Date.now(),
      execHost: host ?? "gateway",
      ...(sandbox ? { sandbox } : {}),
      ...legacy,
    });
    await noteSessionTranscriptHealth({
      cfg: { ...cfg, plugins: { enabled: false } },
      env: state.env,
      sessionDirs: [],
      sessionSqlite: true,
      shouldRepair: true,
    });
    closeOpenClawAgentDatabasesForTest();
    const migrated = listSessionEntriesCore(scope)[0]?.entry;
    expect(migrated?.permissionMode).toBe(expected);
    expect(migrated).not.toHaveProperty("execSecurity");
    expect(migrated).not.toHaveProperty("execAsk");
    // Resolve the stored policy without a sandbox or approval floor masking a
    // broadened migration. These fixtures state the old effective pair explicitly.
    const resolved = resolveExecDefaults({
      cfg,
      agentId: scope.agentId,
      execApprovals: { version: 1 },
      sessionEntry: { execHost: "gateway", permissionMode: migrated?.permissionMode },
    });
    expect(minSecurity(resolved.security, oldPolicy.security)).toBe(resolved.security);
    if (resolved.security !== "deny") {
      expect(maxAsk(resolved.ask, oldPolicy.ask)).toBe(resolved.ask);
    }
  });

  it("migrates persisted restrictions without granting full access and reports each session once", async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-doctor-exec-policy-" });
    const env = state.env;
    const cases: Array<{
      name: string;
      legacy: { execSecurity?: string; execAsk?: string };
      existing?: SessionEntry["permissionMode"];
      expected: SessionEntry["permissionMode"];
    }> = [
      { name: "deny", legacy: { execSecurity: "deny", execAsk: "off" }, expected: "read-only" },
      {
        name: "allowlist",
        legacy: { execSecurity: "allowlist", execAsk: "off" },
        expected: "guarded",
      },
      {
        name: "ask",
        legacy: { execSecurity: "allowlist", execAsk: "on-miss" },
        expected: "guarded",
      },
      // ask=always required approval for every command; no permission mode encodes
      // that, so these rows retire to read-only rather than silently allowing
      // allowlisted commands to run unprompted.
      {
        name: "always",
        legacy: { execSecurity: "full", execAsk: "always" },
        expected: "read-only",
      },
      {
        name: "allowlist-always",
        legacy: { execSecurity: "allowlist", execAsk: "always" },
        expected: "read-only",
      },
      { name: "partial-always", legacy: { execAsk: "always" }, expected: "read-only" },
      { name: "full", legacy: { execSecurity: "full", execAsk: "off" }, expected: undefined },
      {
        name: "full-on-miss",
        legacy: { execSecurity: "full", execAsk: "on-miss" },
        expected: undefined,
      },
      { name: "partial-full", legacy: { execSecurity: "full" }, expected: undefined },
      { name: "partial-deny", legacy: { execSecurity: "deny" }, expected: "read-only" },
      { name: "partial-ask", legacy: { execAsk: "on-miss" }, expected: "read-only" },
      { name: "partial-off", legacy: { execAsk: "off" }, expected: "read-only" },
      {
        name: "existing",
        legacy: { execSecurity: "deny" },
        existing: "workspace",
        expected: "workspace",
      },
      { name: "canonical", legacy: {}, existing: "full", expected: "full" },
    ];
    for (const testCase of cases) {
      const sessionKey = `agent:main:exec-policy-${testCase.name}`;
      const entry = {
        sessionId: `session-${testCase.name}`,
        updatedAt: Date.now(),
        execHost: "node",
        execNode: "bound-node",
        execCwd: "/workspace",
        sandbox: "required" as const,
        ...testCase.legacy,
        ...(testCase.existing ? { permissionMode: testCase.existing } : {}),
      };
      await replaceSessionEntry({ agentId: "main", env, sessionKey }, entry);
    }
    const run = (shouldRepair: boolean) =>
      noteSessionTranscriptHealth({
        cfg: { plugins: { enabled: false } },
        env,
        sessionDirs: [],
        sessionSqlite: true,
        shouldRepair,
      });
    const read = () => listSessionEntriesCore({ agentId: "main", env });
    const before = read();

    await run(false);
    expect(read()).toEqual(before);
    note.mockClear();

    await run(true);
    closeOpenClawAgentDatabasesForTest();
    const repaired = read();
    const lines = note.mock.calls.flatMap(([message]) => String(message).split("\n"));
    for (const testCase of cases) {
      const sessionKey = `agent:main:exec-policy-${testCase.name}`;
      const entry = repaired.find((row) => row.sessionKey === sessionKey)?.entry;
      expect(entry, testCase.name).toMatchObject({
        execHost: "node",
        execNode: "bound-node",
        execCwd: "/workspace",
        sandbox: "required",
      });
      expect(entry?.permissionMode, testCase.name).toBe(testCase.expected);
      expect(entry).not.toHaveProperty("execSecurity");
      expect(entry).not.toHaveProperty("execAsk");
      expect(lines.filter((line) => line.startsWith(`- ${sessionKey}:`))).toHaveLength(
        testCase.name === "canonical" ? 0 : 1,
      );
    }
    const output = lines.join("\n");
    expect(output).toContain("config default applies");
    expect(output).toContain("full permission mode was not granted");
    expect(output).toContain("ask=always has no mode equivalent");
    // The migrated ask=always row must not merely carry a label: resolving its
    // exec policy has to deny execution, so no allowlisted command can run
    // without the human approval the legacy value required.
    for (const name of ["always", "allowlist-always", "partial-always"]) {
      const migrated = repaired.find(
        (row) => row.sessionKey === `agent:main:exec-policy-${name}`,
      )?.entry;
      // Resolve the migrated mode alone: the fixture's sandbox binding would
      // deny on its own and make this assertion vacuous.
      const resolved = resolveExecDefaults({
        cfg: { tools: { exec: { mode: "full" } } },
        execApprovals: { version: 1 },
        sessionEntry: { permissionMode: migrated?.permissionMode },
      });
      expect(resolved.security, name).toBe("deny");
      expect(resolved.mode, name).toBe("deny");
    }
    note.mockClear();
    await run(true);
    expect(read()).toEqual(repaired);
    expect(note.mock.calls.some(([, title]) => title === "Session exec policy")).toBe(false);
  });
});
