import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
} from "../config/sessions/store.js";
import { captureEnv } from "../test-utils/env.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";

const hoisted = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
  allowedRunIds: undefined as Set<string> | undefined,
  registryPath: undefined as string | undefined,
}));
const { announceSpy } = hoisted;
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

vi.mock("./subagent-registry.store.js", async () => {
  const actual = await vi.importActual<typeof import("./subagent-registry.store.js")>(
    "./subagent-registry.store.js",
  );
  const fsSync = await import("node:fs");
  const pathSync = await import("node:path");
  const resolvePath = () => hoisted.registryPath ?? actual.resolveSubagentRegistryPath();
  return {
    ...actual,
    resolveSubagentRegistryPath: resolvePath,
    loadSubagentRegistryFromDisk: () => {
      try {
        const parsed = JSON.parse(fsSync.readFileSync(resolvePath(), "utf8")) as {
          runs?: Record<string, import("./subagent-registry.types.js").SubagentRunRecord>;
        };
        return new Map(Object.entries(parsed.runs ?? {}));
      } catch {
        return new Map();
      }
    },
    saveSubagentRegistryToDisk: (
      runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>,
    ) => {
      const pathname = resolvePath();
      const persistedRuns = hoisted.allowedRunIds
        ? new Map([...runs].filter(([runId]) => hoisted.allowedRunIds?.has(runId)))
        : runs;
      if (hoisted.allowedRunIds && persistedRuns.size === 0 && runs.size > 0) {
        return;
      }
      fsSync.mkdirSync(pathSync.dirname(pathname), { recursive: true });
      fsSync.writeFileSync(
        pathname,
        `${JSON.stringify({ version: 2, runs: Object.fromEntries(persistedRuns) }, null, 2)}\n`,
        "utf8",
      );
    },
  };
});

let mod: typeof import("./subagent-registry.js");
let callGatewayModule: typeof import("../gateway/call.js");
let agentEventsModule: typeof import("../infra/agent-events.js");

describe("subagent registry persistence resume", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    return await writeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      defaultSessionId: `sess-${Date.now()}`,
    });
  };

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
  };

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.js");
    callGatewayModule = await import("../gateway/call.js");
    agentEventsModule = await import("../infra/agent-events.js");
  });

  beforeEach(async () => {
    announceSpy.mockClear();
    vi.mocked(callGatewayModule.callGateway).mockReset();
    vi.mocked(callGatewayModule.callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    mod.__testing.setDepsForTest({
      ...createSubagentRegistryTestDeps({
        callGateway: vi.mocked(callGatewayModule.callGateway),
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      }),
    });
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent).mockReset();
    vi.mocked(agentEventsModule.onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    announceSpy.mockClear();
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    await drainSessionStoreLockQueuesForTest();
    clearSessionStoreCacheForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    hoisted.registryPath = undefined;
    hoisted.allowedRunIds = undefined;
    envSnapshot.restore();
  });

  it("persists runs to disk and resumes after restart", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    hoisted.registryPath = registryPath;
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 2,
          runs: {
            "run-1": {
              runId: "run-1",
              childSessionKey: "agent:main:subagent:test",
              requesterSessionKey: "agent:main:main",
              requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
              requesterDisplayKey: "main",
              task: "do the thing",
              cleanup: "keep",
              createdAt: Date.now(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:test",
      sessionId: "sess-test",
    });

    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as { runs?: Record<string, unknown> };
    expect(parsed.runs && Object.keys(parsed.runs)).toContain("run-1");
    const run = parsed.runs?.["run-1"] as
      | {
          requesterOrigin?: { channel?: string; accountId?: string };
        }
      | undefined;
    expect(run).toBeDefined();
    if (run) {
      expect("requesterAccountId" in run).toBe(false);
      expect("requesterChannel" in run).toBe(false);
    }
    expect(run?.requesterOrigin?.channel).toBe("whatsapp");
    expect(run?.requesterOrigin?.accountId).toBe("acct-main");

    mod.initSubagentRegistry();

    await flushQueuedRegistryWork();
    await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
      timeout: 1_000,
      interval: 10,
    });

    const announceCalls = announceSpy.mock.calls as unknown as Array<[unknown]>;
    const announce = (announceCalls.at(-1)?.[0] ?? undefined) as
      | {
          childRunId?: string;
          childSessionKey?: string;
          requesterSessionKey?: string;
          requesterOrigin?: { channel?: string; accountId?: string };
          task?: string;
          cleanup?: string;
          outcome?: { status?: string };
        }
      | undefined;
    expect(announce).toMatchObject({
      childRunId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "whatsapp",
        accountId: "acct-main",
      },
      task: "do the thing",
      cleanup: "keep",
      outcome: { status: "ok" },
    });

    const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(restored?.childSessionKey).toBe("agent:main:subagent:test");
    expect(restored?.requesterOrigin?.channel).toBe("whatsapp");
    expect(restored?.requesterOrigin?.accountId).toBe("acct-main");
  });
});
