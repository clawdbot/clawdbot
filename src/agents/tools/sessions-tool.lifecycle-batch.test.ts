import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { createSessionsTool } from "./sessions-tool.js";

describe("sessions tool lifecycle batches", () => {
  it("previews ordered archive outcomes without mutating sessions", async () => {
    await withTempDir({ prefix: "openclaw-sessions-tool-batch-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const activeKey = "agent:main:dashboard:active";
      const archivedKey = "agent:main:dashboard:archived";
      await upsertSessionEntry(
        { agentId: "main", sessionKey: activeKey, storePath },
        { sessionId: "active-session", updatedAt: 1 },
      );
      await upsertSessionEntry(
        { agentId: "main", sessionKey: archivedKey, storePath },
        { sessionId: "archived-session", updatedAt: 1, archivedAt: 2 },
      );
      const callGateway = vi.fn();
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        config: {
          session: { store: storePath },
          tools: { sessions: { visibility: "agent" } },
        },
        callGateway,
      });

      const result = await tool.execute("archive-preview", {
        action: "archive",
        sessionKeys: [activeKey, archivedKey, "agent:main:dashboard:missing"],
        dryRun: true,
      });

      expect(callGateway).not.toHaveBeenCalled();
      expect(result.details).toEqual({
        ok: false,
        operation: "archive",
        dryRun: true,
        results: [
          { index: 0, ok: true, status: "would_archive" },
          { index: 1, ok: true, status: "already_archived" },
          {
            index: 2,
            ok: false,
            status: "not_found",
            error: "Session not found or no longer matches the selected generation.",
          },
        ],
      });
    });
  });

  it("rejects lifecycle-only fields on non-lifecycle actions", async () => {
    const tool = createSessionsTool({ agentSessionKey: "agent:main:main", callGateway: vi.fn() });

    await expect(
      tool.execute("patch-with-batch", {
        action: "patch",
        sessionKeys: ["agent:main:dashboard:other"],
        label: "wrong target",
      }),
    ).rejects.toThrow("sessionKeys not valid for action=patch");
  });

  it("continues an archive batch around a current-session target", async () => {
    await withTempDir({ prefix: "openclaw-sessions-tool-self-batch-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const first = "agent:main:dashboard:first";
      const last = "agent:main:dashboard:last";
      await upsertSessionEntry(
        { agentId: "main", sessionKey: first, storePath },
        { sessionId: "first-session", updatedAt: 1 },
      );
      await upsertSessionEntry(
        { agentId: "main", sessionKey: last, storePath },
        { sessionId: "last-session", updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({
        outcomes: [
          { ok: true, key: first },
          { ok: true, key: last },
        ],
      }));
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        config: {
          session: { store: storePath },
          tools: { sessions: { visibility: "agent" } },
        },
        callGateway: callGateway as never,
      });

      const result = await tool.execute("archive-around-self", {
        action: "archive",
        sessionKeys: [first, "agent:main:main", last],
      });

      expect(callGateway).toHaveBeenCalledWith("sessions.patchMany", {
        targets: [
          { key: first, expectedSessionId: "first-session" },
          { key: last, expectedSessionId: "last-session" },
        ],
        patch: { archived: true },
      });
      expect(result.details).toEqual({
        ok: false,
        operation: "archive",
        dryRun: false,
        results: [
          { index: 0, ok: true, status: "archived" },
          {
            index: 1,
            ok: false,
            status: "failed",
            error: "Use action=patch with archived=true to schedule current-session archival.",
          },
          { index: 2, ok: true, status: "archived" },
        ],
      });
    });
  });

  it("keeps maximum-size results complete and bounded", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway,
    });
    const sessionKeys = Array.from(
      { length: 8 },
      (_, index) => `agent:main:dashboard:${index}:${"x".repeat(470)}`,
    );

    const result = await tool.execute("maximum-preview", {
      action: "archive",
      sessionKeys,
      dryRun: true,
    });

    const firstContent = result.content[0];
    const text = firstContent?.type === "text" ? firstContent.text : "";
    expect(callGateway).not.toHaveBeenCalled();
    expect((result.details as { results: unknown[] }).results).toHaveLength(8);
    expect(JSON.parse(text)).toEqual(result.details);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_840);
  });

  it("byte-bounds multibyte errors after a partial mutation", async () => {
    await withTempDir({ prefix: "openclaw-sessions-tool-multibyte-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKeys = Array.from(
        { length: 8 },
        (_, index) => `agent:main:dashboard:multibyte-${index}`,
      );
      for (const [index, sessionKey] of sessionKeys.entries()) {
        await upsertSessionEntry(
          { agentId: "main", sessionKey, storePath },
          { sessionId: `multibyte-session-${index}`, updatedAt: 1 },
        );
      }
      const callGateway = vi.fn(async () => ({
        outcomes: sessionKeys.map((key, index) =>
          index === sessionKeys.length - 1
            ? { ok: true, key }
            : {
                ok: false,
                key,
                error: { code: "INVALID_REQUEST", message: "界".repeat(1_000) },
              },
        ),
      }));
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        config: {
          session: { store: storePath },
          tools: { sessions: { visibility: "agent" } },
        },
        callGateway: callGateway as never,
      });

      const result = await tool.execute("multibyte-errors", {
        action: "archive",
        sessionKeys,
      });

      const firstContent = result.content[0];
      const text = firstContent?.type === "text" ? firstContent.text : "";
      const details = result.details as {
        results: Array<{ status: string; detailsOmitted?: boolean; error?: string }>;
      };
      expect(details.results).toHaveLength(8);
      expect(details.results.at(-1)?.status).toBe("archived");
      expect(details.results.every((entry) => entry.detailsOmitted !== true)).toBe(true);
      expect(
        details.results
          .filter((entry) => entry.error)
          .every((entry) => Buffer.byteLength(entry.error ?? "", "utf8") <= 160),
      ).toBe(true);
      expect(JSON.parse(text)).toEqual(result.details);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_840);
    });
  });
});
