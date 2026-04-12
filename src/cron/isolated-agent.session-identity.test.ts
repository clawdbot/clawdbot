import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelSelection from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, writeSessionStore } from "./isolated-agent.test-harness.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  DEFAULT_MESSAGE,
  makeDeps,
  mockEmbeddedOk,
  readSessionEntry,
  runCronTurn,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";

setupRunCronIsolatedAgentTurnSuite();

describe("runCronIsolatedAgentTurn session identity", () => {
  beforeEach(() => {
    vi.spyOn(modelSelection, "resolveThinkingDefault").mockReturnValue("off");
    vi.mocked(runEmbeddedPiAgent).mockClear();
  });

  it("passes resolved agentDir to runEmbeddedPiAgent", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        agentDir?: string;
      };
      expect(call?.agentDir).toBe(path.join(home, ".openclaw", "agents", "main", "agent"));
    });
  });

  it("appends current time after the cron header line", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        prompt?: string;
      };
      const lines = call?.prompt?.split("\n") ?? [];
      expect(lines[0]).toContain("[cron:job-1");
      expect(lines[0]).toContain("do it");
      expect(lines[1]).toMatch(/^Current time: .+ \(.+\) \/ \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    });
  });

  it("uses agentId for workspace, session key, and store paths", async () => {
    await withTempHome(async (home) => {
      const deps = makeDeps();
      const opsWorkspace = path.join(home, "ops-workspace");
      mockEmbeddedOk();

      const cfg = makeCfg(
        home,
        path.join(home, ".openclaw", "agents", "{agentId}", "sessions", "sessions.json"),
        {
          agents: {
            defaults: { workspace: path.join(home, "default-workspace") },
            list: [
              { id: "main", default: true },
              { id: "ops", workspace: opsWorkspace },
            ],
          },
        },
      );

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
          }),
          agentId: "ops",
          delivery: { mode: "none" },
        },
        message: DEFAULT_MESSAGE,
        sessionKey: "cron:job-ops",
        agentId: "ops",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        sessionKey?: string;
        workspaceDir?: string;
        sessionFile?: string;
      };
      expect(call?.sessionKey).toBe("agent:ops:cron:job-ops");
      expect(call?.workspaceDir).toBe(opsWorkspace);
      expect(call?.sessionFile).toContain(path.join("agents", "ops"));
    });
  });

  it("passes sessionFile to isolated cron runs", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        sessionFile?: string;
      };

      expect(call?.sessionFile).toContain(
        path.join(home, ".openclaw", "agents", "main", "sessions"),
      );
      expect(call?.sessionFile?.endsWith(".jsonl")).toBe(true);
    });
  });

  it("starts a fresh session id for each cron run", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = makeDeps();
      const runPingTurn = () =>
        runCronTurn(home, {
          deps,
          jobPayload: { kind: "agentTurn", message: "ping" },
          message: "ping",
          mockTexts: ["ok"],
          storePath,
        });

      const first = (await runPingTurn()).res;
      const second = (await runPingTurn()).res;

      expect(first.sessionId).toBeDefined();
      expect(second.sessionId).toBeDefined();
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(first.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).not.toBe(first.sessionKey);
    });
  });

  it("preserves an existing cron session label", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const raw = await fs.readFile(storePath, "utf-8");
      const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      store["agent:main:cron:job-1"] = {
        sessionId: "old",
        updatedAt: Date.now(),
        label: "Nightly digest",
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

      await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: "ping" },
        message: "ping",
        storePath,
      });
      const entry = await readSessionEntry(storePath, "agent:main:cron:job-1");

      expect(entry?.label).toBe("Nightly digest");
    });
  });
});
