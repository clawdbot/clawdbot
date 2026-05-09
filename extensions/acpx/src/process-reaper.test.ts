import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxProcessTree,
  isOpenClawOwnedAcpxProcessCommand,
  reapStaleOpenClawOwnedAcpxOrphans,
  type AcpxProcessInfo,
} from "./process-reaper.js";

const WRAPPER_ROOT = "/tmp/openclaw-state/acpx";
const CODEX_WRAPPER_COMMAND = `node ${WRAPPER_ROOT}/codex-acp-wrapper.mjs`;
const CODEX_WRAPPER_COMMAND_WITH_LEASE = `${CODEX_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-1 ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-1`;
const CLAUDE_WRAPPER_COMMAND = `node ${WRAPPER_ROOT}/claude-agent-acp-wrapper.mjs`;
const PLUGIN_DEPS_CODEX_COMMAND =
  "node /tmp/openclaw/plugin-runtime-deps/node_modules/@zed-industries/codex-acp/bin/codex-acp.js";

function cleanupDeps(processes: AcpxProcessInfo[]) {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    killed,
    deps: {
      listProcesses: vi.fn(async () => processes),
      killProcess: vi.fn((pid: number, signal: NodeJS.Signals) => {
        killed.push({ pid, signal });
      }),
      sleep: vi.fn(async () => {}),
    },
  };
}

function collectMatching<T, U>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  map: (item: T) => U,
): U[] {
  const matches: U[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(map(item));
    }
  }
  return matches;
}

describe("process reaper", () => {
  it("recognizes generated Codex and Claude wrappers only under the configured root", () => {
    expect(
      isOpenClawOwnedAcpxProcessCommand({
        command: CODEX_WRAPPER_COMMAND,
        wrapperRoot: WRAPPER_ROOT,
      }),
    ).toBe(true);
    expect(
      isOpenClawOwnedAcpxProcessCommand({
        command: CLAUDE_WRAPPER_COMMAND,
        wrapperRoot: WRAPPER_ROOT,
      }),
    ).toBe(true);
    expect(
      isOpenClawOwnedAcpxProcessCommand({
        command: "node /tmp/other/codex-acp-wrapper.mjs",
        wrapperRoot: WRAPPER_ROOT,
      }),
    ).toBe(false);
  });

  it("recognizes OpenClaw plugin-runtime-deps ACP adapter children", () => {
    expect(isOpenClawOwnedAcpxProcessCommand({ command: PLUGIN_DEPS_CODEX_COMMAND })).toBe(true);
    expect(isOpenClawOwnedAcpxProcessCommand({ command: "npx @zed-industries/codex-acp" })).toBe(
      false,
    );
  });

  it("kills an owned recorded process tree children first", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 100, ppid: 1, command: CODEX_WRAPPER_COMMAND },
      { pid: 101, ppid: 100, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 102, ppid: 101, command: "node child.js" },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 100,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.inspectedPids).toEqual([100, 101, 102]);
    expect(killed.slice(0, 3)).toEqual([
      { pid: 102, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);
  });

  it("allows wrapper-root verification when stored wrapper commands are shell-quoted", async () => {
    const { deps, killed } = cleanupDeps([{ pid: 110, ppid: 1, command: CODEX_WRAPPER_COMMAND }]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 110,
      rootCommand: `"/usr/local/bin/node" "${WRAPPER_ROOT}/codex-acp-wrapper.mjs"`,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(killed[0]).toEqual({ pid: 110, signal: "SIGTERM" });
  });

  it("requires matching lease identity before killing a leased process tree", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 112, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 112,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(killed[0]).toEqual({ pid: 112, signal: "SIGTERM" });
  });

  it("does not kill a reused same-root wrapper pid with a different lease identity", async () => {
    const { deps, killed } = cleanupDeps([
      {
        pid: 113,
        ppid: 1,
        command: `${CODEX_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} other-lease ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-1`,
      },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 113,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result).toEqual({
      inspectedPids: [113],
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    });
    expect(killed).toEqual([]);
  });

  it("skips recorded pid cleanup when process listing is unavailable", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 200,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => {
          throw new Error("ps unavailable");
        }),
        killProcess: vi.fn((pid, signal) => {
          killed.push({ pid, signal });
        }),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(result).toEqual({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "unverified-root",
    });
    expect(killed).toEqual([]);
  });

  it("does not kill a reused pid when the live command is not OpenClaw-owned", async () => {
    const { deps, killed } = cleanupDeps([{ pid: 250, ppid: 1, command: "node unrelated.js" }]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 250,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result).toEqual({
      inspectedPids: [250],
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    });
    expect(killed).toEqual([]);
  });

  it("does not kill a reused adapter pid when the stored root was a generated wrapper", async () => {
    const { deps, killed } = cleanupDeps([
      {
        pid: 260,
        ppid: 1,
        command: PLUGIN_DEPS_CODEX_COMMAND,
      },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 260,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result).toEqual({
      inspectedPids: [260],
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    });
    expect(killed).toEqual([]);
  });

  it("skips non-owned recorded process trees", async () => {
    const { deps, killed } = cleanupDeps([{ pid: 300, ppid: 1, command: "node server.js" }]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 300,
      rootCommand: "node server.js",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBe("not-openclaw-owned");
    expect(killed).toEqual([]);
  });

  it("reaps stale OpenClaw-owned wrapper and adapter orphans on startup", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 400, ppid: 1, command: CODEX_WRAPPER_COMMAND },
      { pid: 401, ppid: 400, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 402, ppid: 401, command: "node child.js" },
      { pid: 403, ppid: 1, command: CLAUDE_WRAPPER_COMMAND },
      { pid: 404, ppid: 403, command: "node claude-child.js" },
      { pid: 405, ppid: 1, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 406, ppid: 1, command: "node /tmp/other/codex-acp-wrapper.mjs" },
    ]);

    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.inspectedPids).toEqual([400, 401, 402, 403, 404, 405]);
    expect(
      collectMatching(
        killed,
        (entry) => entry.signal === "SIGTERM",
        (entry) => entry.pid,
      ),
    ).toEqual([402, 401, 400, 404, 403, 405]);
  });

  it("keeps startup scans quiet when process listing is unavailable", async () => {
    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => {
          throw new Error("ps unavailable");
        }),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(result).toEqual({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "process-list-unavailable",
    });
  });
});
