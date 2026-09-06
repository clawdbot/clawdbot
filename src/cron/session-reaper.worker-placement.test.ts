import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadExactSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const mocks = vi.hoisted(() => ({
  deleteCronSessionViaGateway: vi.fn(),
}));

vi.mock("./isolated-agent/session-cleanup.js", () => ({
  deleteCronSessionViaGateway: mocks.deleteCronSessionViaGateway,
}));

import { removeCronJobBaseSession } from "./session-reaper.js";

const { makeStorePath } = setupCronServiceSuite({
  prefix: "cron-reaper-worker-placement-",
});

describe("removeCronJobBaseSession worker placement", () => {
  beforeEach(() => {
    mocks.deleteCronSessionViaGateway.mockReset();
  });

  it("routes a session through the gateway even before any placement is observed", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:unplaced-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "unplaced-session", updatedAt: 123 },
    );
    const existing = loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })!.entry;
    mocks.deleteCronSessionViaGateway.mockResolvedValue(true);

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "unplaced-job",
        sessionStorePath,
      }),
    ).resolves.toBe(true);

    expect(mocks.deleteCronSessionViaGateway).toHaveBeenCalledWith({
      agentSessionKey: sessionKey,
      sessionId: "unplaced-session",
      lifecycleRevision: existing.lifecycleRevision,
      sessionUpdatedAt: existing.updatedAt,
    });
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeDefined();
  });

  it("preserves the session when the gateway rejects deletion", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:raced-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "raced-session", updatedAt: 234 },
    );
    mocks.deleteCronSessionViaGateway.mockRejectedValue(new Error("Session identity changed"));

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "raced-job",
        sessionStorePath,
      }),
    ).rejects.toThrow("Session identity changed");

    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toMatchObject({
      entry: { sessionId: "raced-session" },
    });
  });

  it.each(["", " \t\n"])(
    "removes a legacy session with unusable id %j directly",
    async (sessionId) => {
      const { storePath } = await makeStorePath();
      const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
      const sessionKey = "agent:main:cron:local-job";
      await replaceSessionEntry(
        { agentId: "main", storePath: sessionStorePath, sessionKey },
        { sessionId, updatedAt: 456 },
      );

      await expect(
        removeCronJobBaseSession({
          agentId: "main",
          jobId: "local-job",
          sessionStorePath,
        }),
      ).resolves.toBe(true);

      expect(mocks.deleteCronSessionViaGateway).not.toHaveBeenCalled();
      expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
    },
  );
});
