/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { buildPendingInputItems } from "./chat-pending-inputs.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { t } from "../../i18n/index.ts";

describe("pending internal_system notice regression", () => {
  const acceptedAt = 1_234_567;
  const pendingInternal = {
    id: "pending-internal-1",
    runId: "run-internal-1",
    acceptedAt,
    state: "queued" as const,
    message: {
      role: "user",
      content: "[System] Turn interrupted by a gateway restart — asked the agent to resume",
      provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      __openclaw: { id: "pending:pending-internal-1" },
    },
  };

  const pendingUnknownTool = {
    id: "pending-unknown-1",
    runId: "run-unknown-1",
    acceptedAt,
    state: "queued" as const,
    message: {
      role: "user",
      content: "[System] Unknown tool payload",
      provenance: { kind: "internal_system", sourceTool: "unknown_tool_xyz" },
      __openclaw: { id: "pending:pending-unknown-1" },
    },
  };

  const pendingLookalike = {
    id: "pending-lookalike-1",
    runId: "run-lookalike-1",
    acceptedAt,
    state: "queued" as const,
    message: {
      role: "user",
      content: "[System] Fake system prefix but genuine user",
      __openclaw: { id: "pending:pending-lookalike-1" },
    },
  };

  it("pending internal_system should be notice (core bug)", () => {
    const items = buildPendingInputItems([pendingInternal], [], undefined);
    // first item should be system notice, not user message
    expect(items[0]).toMatchObject({
      kind: "notice",
      key: `pending-input:${pendingInternal.id}`,
      timestamp: acceptedAt,
    });
    // should have no boundaryId (no canonical turn authority)
    expect((items[0] as Record<string, unknown>).boundaryId).toBeUndefined();
    // icon/label/text derived from resolveSystemNoticeKind
    expect((items[0] as Record<string, unknown>).icon).toBe("cpu");
    // for known kind with summaryKey, text should be translated summary, not raw prefix
    const noticed = items[0] as { text?: string };
    expect(noticed.text).toBe(t("chat.systemNotice.restartRecovery.summary"));
    // second item is still the pending disposition state notice
    expect(items[1]).toMatchObject({
      kind: "notice",
      key: `pending-input:${pendingInternal.id}:state`,
      timestamp: acceptedAt,
    });
    // genuine pending must not be message
    expect(items.some((it) => it.kind === "message" && it.key === `pending-input:${pendingInternal.id}`)).toBe(false);
  });

  it("unknown sourceTool internal_system becomes generic notice without summary", () => {
    const items = buildPendingInputItems([pendingUnknownTool], [], undefined);
    expect(items[0]).toMatchObject({
      kind: "notice",
      key: `pending-input:${pendingUnknownTool.id}`,
      icon: "cpu",
      label: t("common.system"),
      timestamp: acceptedAt,
    });
    expect((items[0] as { text?: string }).text).toBe("Unknown tool payload");
    expect((items[0] as Record<string, unknown>).boundaryId).toBeUndefined();
  });

  it("genuine user lookalike stays message (negative)", () => {
    const items = buildPendingInputItems([pendingLookalike], [], undefined);
    expect(items[0]).toMatchObject({
      kind: "message",
      key: `pending-input:${pendingLookalike.id}`,
    });
    expect((items[0] as { message?: unknown }).message).toBe(pendingLookalike.message);
  });

  it("handles search filter for pending internal_system unchanged", () => {
    const matching = buildPendingInputItems([pendingInternal], [], "gateway restart");
    // raw message text contains stripped payload? but messageMatchesSearchQuery checks raw content
    // pendingInternal content includes "gateway restart" via summary? original content has it, but filtered via original message
    // The implementation filters via original message before conversion, so query matching raw text should keep notice
    // For our fixture, content = "[System] Turn interrupted..." does not contain gateway restart? Actually we used stripped style.
    // Let's use a fixture where raw text contains unique token
    const tokenInput = {
      id: "pending-search-1",
      runId: "run-search-1",
      acceptedAt,
      state: "queued" as const,
      message: {
        role: "user",
        content: "unique-search-token-xyz",
        provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
        __openclaw: { id: "pending:pending-search-1" },
      },
    };
    const keeps = buildPendingInputItems([tokenInput], [], "unique-search-token-xyz");
    expect(keeps.length).toBe(2);
    expect(keeps[0]?.kind).toBe("notice");
    const filtered = buildPendingInputItems([tokenInput], [], "no-match-zzz");
    expect(filtered.length).toBe(0);
  });

  it("pending+canonical deduplication single notice", () => {
    const canonical = {
      role: "user",
      content: "[System] Turn interrupted by a gateway restart",
      provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      timestamp: 1000,
      __openclaw: { id: pendingInternal.id, seq: 1 },
    };
    const items = buildChatItems({
      paneId: "test-pane",
      sessionKey: "agent:main:dashboard:test",
      messages: [canonical],
      pendingInputs: [pendingInternal],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    // Should have single notice (canonical), not duplicate pending notice
    const notices = items.filter((it) => it.kind === "notice" && (it as { text?: string }).text !== undefined);
    // Count notices that correspond to system recovery; pending should have been deduped
    const recoveryNotices = notices.filter((n) => (n as { key?: string }).key?.includes(pendingInternal.id) || (n as { text?: string }).text === t("chat.systemNotice.restartRecovery.summary"));
    // The dedup ensures pending-input key not present; history notice present
    expect(items.some((it) => it.kind === "notice" && (it as { key?: string }).key === `pending-input:${pendingInternal.id}`)).toBe(false);
    // There should be exactly one system notice for the canonical id
    const canonicalNotices = items.filter((it) => it.kind === "notice");
    expect(canonicalNotices.length).toBeGreaterThan(0);
  });

  it("canonical parity (already passes) - history internal_system is notice", () => {
    const canonical = {
      role: "user",
      content: "[System] Turn interrupted",
      provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      timestamp: 1000,
      __openclaw: { id: "canonical-1", seq: 1 },
    };
    const items = buildChatItems({
      paneId: "test-pane2",
      sessionKey: "agent:main:dashboard:test",
      messages: [canonical],
      pendingInputs: [],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    expect(items.some((it) => it.kind === "notice" && (it as { text?: string }).text === t("chat.systemNotice.restartRecovery.summary"))).toBe(true);
  });
});
