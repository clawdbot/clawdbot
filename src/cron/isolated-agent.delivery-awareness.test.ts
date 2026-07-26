// Delivery awareness tests cover isolated agent knowledge of cron delivery targets.
import fs from "node:fs/promises";
import path from "node:path";
import "./isolated-agent.mocks.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import { resolveDefaultSessionStorePath } from "../config/sessions.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";
import { resetCompletedDirectCronDeliveriesForTests } from "./isolated-agent/delivery-dispatch.test-support.js";

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
  beforeAll(async () => {
    setupIsolatedAgentTurnMocks();
    resetCompletedDirectCronDeliveriesForTests();
    resetSystemEventsForTest();
    await withTempCronHome(async (home) => {
      const storePath = await writeDefaultAgentSessionStoreEntries({});
      mockAgentPayloads([{ text: "warm runtime" }]);
      await runAnnounceTurn({
        home,
        storePath,
        sessionKey: "cron:warm-runtime",
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });
    });
  });

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

  it("refuses keyless implicit last-target delivery inherited from the shared main bucket, queuing no awareness", async () => {
    // #91613: a keyless implicit cron (sessionTarget "isolated", delivery.channel "last", no `to`)
    // would inherit the SHARED agent-main bucket's lastTo. In a multi-conversation agent that room
    // belongs to whichever conversation last wrote main — the wrong room — and the durable queue
    // replays it after a restart. It is now refused at the delivery dispatch !ok gate (errorKind
    // delivery-target) — the agent turn still runs, but delivery is refused, so nothing reaches the
    // wrong room or the durable queue, and no main-session awareness event is queued. (This is the
    // single-conversation behavior change called out for the maintainer: a keyless cron must now
    // pin delivery.to / delivery.channel, or run from a session that carries its own context.)
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

      expect(result.status).toBe("error");
      expect(result.delivered).toBeFalsy();
      expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
    });
  });
});
