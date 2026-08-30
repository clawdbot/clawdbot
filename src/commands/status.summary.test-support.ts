/** Shared status-summary cases for recent sessions, runtime, and context-window projection. */
import { describe, expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";

type GetStatusSummary = typeof import("../status/summary.js").getStatusSummary;
type StatusSummaryRuntime = typeof import("../status/summary.runtime.js").statusSummaryRuntime;
type SessionStore = Record<string, Record<string, unknown>>;

export function registerStatusSummarySessionRowCases(params: {
  getStatusSummary: () => ReturnType<GetStatusSummary>;
  getStatusSummaryRuntime: () => StatusSummaryRuntime;
  rejectProviderStaticModel: (error: Error) => void;
  setSessions: (store: SessionStore) => void;
}): void {
  describe("status summary session rows", () => {
    it("projects only recent session rows while preserving total counts", async () => {
      params.setSessions(
        Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => {
            const number = index + 1;
            return [
              `agent:main:session-${number}`,
              {
                sessionId: `session-${number}`,
                updatedAt: number,
              },
            ];
          }),
        ),
      );

      const summary = await params.getStatusSummary();

      expect(summary.sessions.count).toBe(12);
      expect(summary.sessions.byAgent[0]?.count).toBe(12);
      expect(summary.sessions.recent.map((session) => session.key)).toEqual([
        "agent:main:session-12",
        "agent:main:session-11",
        "agent:main:session-10",
        "agent:main:session-9",
        "agent:main:session-8",
        "agent:main:session-7",
        "agent:main:session-6",
        "agent:main:session-5",
        "agent:main:session-4",
        "agent:main:session-3",
      ]);
      expect(summary.sessions.byAgent[0]?.recent.map((session) => session.key)).toEqual(
        summary.sessions.recent.map((session) => session.key),
      );

      const hydratedKeys = vi
        .mocked(params.getStatusSummaryRuntime().resolveSessionRuntime)
        .mock.calls.map(([call]) => call.sessionKey);
      expect(hydratedKeys).not.toContain("agent:main:session-1");
      expect(hydratedKeys).not.toContain("agent:main:session-2");
    });

    it("preserves canonical key order for tied recent session timestamps", async () => {
      params.setSessions(
        Object.fromEntries(
          Array.from({ length: 11 }, (_, index) => {
            const number = index + 1;
            return [
              `agent:main:session-${number}`,
              {
                sessionId: `session-${number}`,
                updatedAt: 1,
              },
            ];
          }),
        ),
      );

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent.map((session) => session.key)).toEqual([
        "agent:main:session-1",
        "agent:main:session-10",
        "agent:main:session-11",
        "agent:main:session-2",
        "agent:main:session-3",
        "agent:main:session-4",
        "agent:main:session-5",
        "agent:main:session-6",
        "agent:main:session-7",
        "agent:main:session-8",
      ]);
      expect(summary.sessions.byAgent[0]?.recent.map((session) => session.key)).toEqual(
        summary.sessions.recent.map((session) => session.key),
      );
    });

    it("keeps status available when static catalog lookup fails", async () => {
      vi.mocked(
        params.getStatusSummaryRuntime().resolveConfiguredStatusModelRef,
      ).mockReturnValueOnce({
        provider: "broken-provider",
        model: "broken-model",
      });
      params.rejectProviderStaticModel(new Error("static catalog unavailable"));

      await expect(params.getStatusSummary()).resolves.toMatchObject({
        sessions: {
          defaults: {
            model: "broken-model",
            contextTokens: 200_000,
          },
        },
      });
    });

    it("includes the selected agent runtime on recent sessions", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.runtime).toBe("OpenAI Codex");
    });

    it("rejects a stale runtime window after a same-model harness change", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        1_000_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "same-model-runtime-change",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          totalTokens: 11,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]).toMatchObject({
        runtime: "OpenAI Codex",
        contextTokens: 1_000_000,
        remainingTokens: 999_989,
      });
    });

    it("keeps telemetry from the matching runtime producer", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        1_000_000,
      );
      params.setSessions({
        "agent:main:main": {
          sessionId: "matching-runtime-window",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          totalTokens: 11,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(272_000);
    });

    it("replaces matching runtime telemetry with a newly authored effective cap", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveAuthoredModelContextTokens).mockReturnValue(
        1_000_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        1_000_000,
      );
      params.setSessions({
        "agent:main:main": {
          sessionId: "authored-context-cap",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(1_000_000);
    });

    it("preserves the native window owned by a locked legacy session", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        272_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "locked-legacy-window",
          updatedAt: Date.now(),
          modelSelectionLocked: true,
          contextTokens: 1_000_000,
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(1_000_000);
    });

    it("caps matching unlocked runtime telemetry to the lower current window", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        272_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "unlocked-runtime-window",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
          contextTokens: 1_000_000,
          contextTokensSource: "runtime",
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(272_000);
    });
  });
}
