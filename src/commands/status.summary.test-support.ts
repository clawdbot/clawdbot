/** Shared status-summary cases for session runtime and context-window projection. */
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
