import fs from "node:fs/promises";
import path from "node:path";
import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import { resolveDefaultSessionStorePath } from "../config/sessions.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";
import { resetCompletedDirectCronDeliveriesForTests } from "./isolated-agent/delivery-dispatch.js";

async function writeDefaultAgentSessionStoreEntries(
  entries: Record<string, Record<string, unknown>>,
): Promise<string> {
  const storePath = resolveDefaultSessionStorePath("main");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(entries, null, 2), "utf-8");
  return storePath;
}

async function runAnnounceTurn(params: {
  home: string;
  storePath: string;
  sessionKey: string;
  deps?: CliDeps;
  cfgOverrides?: Partial<ReturnType<typeof makeCfg>>;
  delivery: {
    mode: "announce";
    channel: "last" | "telegram";
    to?: string;
    bestEffort?: boolean;
  };
}) {
  return await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath, params.cfgOverrides),
    deps: params.deps ?? createCliDeps(),
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      sessionTarget: "isolated",
      delivery: params.delivery,
    },
    message: "do it",
    sessionKey: params.sessionKey,
    lane: "cron",
  });
}

describe("runCronIsolatedAgentTurn cron delivery awareness", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
    resetCompletedDirectCronDeliveriesForTests();
    resetSystemEventsForTest();
  });

  it("queues delivered isolated cron text for the next main-session turn", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeDefaultAgentSessionStoreEntries({});
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);

      const result = await runAnnounceTurn({
        home,
        storePath,
        sessionKey: "cron:job-1",
        deps,
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
        },
      });

      expect(result.status).toBe("ok");
      expect(result.delivered).toBe(true);
      expect(peekSystemEvents("agent:main:main")).toEqual(["hello from cron"]);
    });
  });

  it("uses the global main queue when session scope is global", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeDefaultAgentSessionStoreEntries({});
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "global cron digest" }]);

      const result = await runAnnounceTurn({
        home,
        storePath,
        sessionKey: "cron:job-1",
        deps,
        cfgOverrides: {
          session: { scope: "global", store: storePath, mainKey: "main" },
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
        },
      });

      expect(result.status).toBe("ok");
      expect(result.delivered).toBe(true);
      expect(peekSystemEvents("global")).toEqual(["global cron digest"]);
    });
  });

  it("does not queue main-session awareness for implicit last-target delivery", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeDefaultAgentSessionStoreEntries({
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastChannel: "telegram",
          lastTo: "123",
        },
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "implicit cron digest" }]);

      const result = await runAnnounceTurn({
        home,
        storePath,
        sessionKey: "cron:job-1",
        deps,
        delivery: {
          mode: "announce",
          channel: "last",
        },
      });

      expect(result.status).toBe("ok");
      expect(result.delivered).toBe(true);
      expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
    });
  });
});
