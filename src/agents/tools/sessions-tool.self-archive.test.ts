import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createSessionsTool } from "./sessions-tool.js";

describe("sessions tool self-archive", () => {
  it("defers self-archiving until the current agent turn has completed", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-self-archive-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:self-archive";
      const sessionId = "session-self-archive";
      const config: OpenClawConfig = { session: { store: storePath } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config,
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        const result = await admission.run(async () => {
          const pending = await tool.execute("archive-current", {
            action: "patch",
            archived: true,
          });
          expect(callGateway).not.toHaveBeenCalled();
          expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
            "archivedAt",
          );
          return pending;
        });

        expect(result.details).toMatchObject({
          status: "scheduled",
          sessionKey,
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledExactlyOnceWith({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
          },
        });
      });
    });
  });

  it("applies other self-patch settings before the deferred archive", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-patch-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:archive-patch";
      const sessionId = "session-archive-patch";
      const config: OpenClawConfig = { session: { store: storePath } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config,
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        await admission.run(async () => {
          const result = await tool.execute("archive-and-label", {
            action: "patch",
            label: "Finished research",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
          expect(callGateway).toHaveBeenCalledExactlyOnceWith({
            method: "sessions.patch",
            params: {
              key: sessionKey,
              label: "Finished research",
              expectedSessionId: sessionId,
            },
          });
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway.mock.calls).toEqual([
          [
            {
              method: "sessions.patch",
              params: { key: sessionKey, label: "Finished research", expectedSessionId: sessionId },
            },
          ],
          [
            {
              method: "sessions.patch",
              params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
            },
          ],
        ]);
      });
    });
  });

  it("does not apply a deferred archive to a replacement session", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-replacement-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:archive-replacement";
      const sessionId = "session-before-reset";
      const config: OpenClawConfig = { session: { store: storePath } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config,
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      let replacementAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;

      try {
        await admission.run(async () => {
          await tool.execute("archive-before-reset", { action: "patch", archived: true });
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey, storePath },
            { sessionId: "session-after-reset", updatedAt: 2 },
          );
          replacementAdmission = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, "session-after-reset"],
            assertAllowed: () => {},
          });
        });
      } finally {
        admission.release();
      }

      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(callGateway).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
          sessionId: "session-after-reset",
        });
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
          "archivedAt",
        );
      } finally {
        replacementAdmission?.release();
      }
    });
  });

  it("waits for a competing turn before applying a scheduled archive", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-competing-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:archive-competing";
      const sessionId = "session-archive-competing";
      const config: OpenClawConfig = { session: { store: storePath } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config,
        callGateway: callGateway as never,
      });
      const currentAdmission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      const competingAdmission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        await currentAdmission.run(async () => {
          const result = await tool.execute("archive-after-competition", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
        currentAdmission.release();

        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(callGateway).not.toHaveBeenCalled();
      } finally {
        currentAdmission.release();
        competingAdmission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledExactlyOnceWith({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
          },
        });
      });
    });
  });

  it("retries a scheduled archive when a turn races the gateway mutation", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-retry-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:archive-retry";
      const sessionId = "session-archive-retry";
      const config: OpenClawConfig = { session: { store: storePath } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      let competingAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      const callGateway = vi.fn(async () => {
        if (!competingAdmission) {
          competingAdmission = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, sessionId],
            assertAllowed: () => {},
          });
          throw Object.assign(new Error("Session did not finish stopping."), { retryable: true });
        }
        return { ok: true };
      });
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config,
        callGateway: callGateway as never,
      });
      const currentAdmission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        await currentAdmission.run(async () => {
          const result = await tool.execute("archive-after-race", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
        currentAdmission.release();

        await vi.waitFor(() => {
          expect(callGateway).toHaveBeenCalledTimes(1);
          expect(competingAdmission).toBeDefined();
        });
      } finally {
        currentAdmission.release();
        competingAdmission?.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledTimes(2);
        expect(callGateway).toHaveBeenLastCalledWith({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
          },
        });
      });
    });
  });

  it("retries when a competing turn releases before its archive rejection settles", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-release-race-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:archive-release-race";
      const sessionId = "session-archive-release-race";
      const config: OpenClawConfig = { session: { store: storePath } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      let competingTurnFinished = false;
      const callGateway = vi.fn(async () => {
        if (!competingTurnFinished) {
          const competingAdmission = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, sessionId],
            assertAllowed: () => {},
          });
          competingAdmission.release();
          competingTurnFinished = true;
          throw Object.assign(new Error("Session did not finish stopping."), { retryable: true });
        }
        return { ok: true };
      });
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config,
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        await admission.run(async () => {
          const result = await tool.execute("archive-after-release-race", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledTimes(2);
        expect(callGateway).toHaveBeenLastCalledWith({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
          },
        });
      });
    });
  });

  it("retries a scheduled archive after a transient gateway failure", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-transport-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:archive-transport";
      const sessionId = "session-archive-transport";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
        .mockResolvedValue({ ok: true });
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config: { session: { store: storePath } },
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        await admission.run(async () => {
          const result = await tool.execute("archive-after-disconnect", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledTimes(2);
        expect(callGateway).toHaveBeenLastCalledWith({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
          },
        });
      });
    });
  });

  it("keeps retrying a projected active run without abandoning its archive", async () => {
    vi.useFakeTimers();
    try {
      await withTestDir({ prefix: "openclaw-sessions-tool-archive-projected-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        const sessionKey = "agent:main:archive-projected";
        const sessionId = "session-archive-projected";
        const config: OpenClawConfig = { session: { store: storePath } };
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          { sessionId, updatedAt: 1 },
        );
        let attempts = 0;
        const callGateway = vi.fn(async () => {
          attempts += 1;
          if (attempts <= 10) {
            throw Object.assign(new Error("Session did not finish stopping."), {
              retryable: true,
            });
          }
          return { ok: true };
        });
        const tool = createSessionsTool({
          agentSessionKey: sessionKey,
          agentSessionId: sessionId,
          config,
          callGateway: callGateway as never,
        });
        const admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, sessionId],
          assertAllowed: () => {},
        });

        try {
          await admission.run(async () => {
            const result = await tool.execute("archive-after-projected-run", {
              action: "patch",
              archived: true,
            });
            expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
          });
        } finally {
          admission.release();
        }

        await vi.advanceTimersByTimeAsync(30_000);
        expect(callGateway).toHaveBeenCalledTimes(11);
        expect(callGateway).toHaveBeenLastCalledWith({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
          },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps main-session archive validation on the gateway", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-main-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const sessionId = "session-main-archive";
      const config: OpenClawConfig = { session: { store: storePath } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config,
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        await admission.run(async () => {
          await tool.execute("archive-main", { action: "patch", archived: true });
          expect(callGateway).toHaveBeenCalledExactlyOnceWith({
            method: "sessions.patch",
            params: {
              key: sessionKey,
              expectedSessionId: sessionId,
              archived: true,
            },
          });
        });
      } finally {
        admission.release();
      }
    });
  });
});
