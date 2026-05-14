import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

/**
 * Catalog #20 — `model` / `modelProvider` reported as agent-config, not ACP runtime actuals.
 *
 * Bug summary: For ACP-keyed sessions (e.g. `agent:copilot:acp:<uuid>`), the
 * `--json` listing reports the AGENT's configured model
 * (e.g. `model: "gpt-5.3-codex"`, `modelProvider: "microsoft-foundry"`) — but
 * those are the values the openclaw-agent-driven flow would have used. When
 * the same agent runs as an ACP child via `copilot --acp --stdio`, the actual
 * underlying model selection lives inside copilot CLI and is independent of
 * the agent's configured model. The listing happily reports the agent default
 * regardless of whether the session actually ran via ACP.
 *
 * `resolveSessionDisplayModelRef` (`src/commands/sessions-display-model.ts:123-148`)
 * has zero ACP-awareness: it only consults the session entry's persisted
 * `model` / `modelProvider` / `modelOverride` and the agent's configured
 * default. It never inspects the session key or the persisted ACP metadata.
 *
 * Decided fix shape (catalog #20, mirrors #18): SENTINEL OVERLAY at the call
 * site, gated on BOTH key shape AND persisted `entry.acp` metadata. Key shape
 * alone is not sufficient because ACP bridge sessions (translator.ts) also use
 * ACP-shaped keys without ever writing `SessionAcpMeta` — those sessions run
 * the normal configured model and must not receive the sentinel.
 *
 * When `isAcpSessionKey(row.key)` is true AND `entry.acp != null`, the
 * JSON-emit path overlays `{ provider: "acpx", model: "<agentId>-acp" }` on
 * top of the resolver result. The resolver itself stays pure.
 *
 * NOTE ON DRIVING SURFACE: `resolveSessionDisplayModelRef` is exported, but
 * the bug as observed by operators surfaces through `sessions --json`, so we
 * drive the test end-to-end through `sessionsCommand --json` (mirroring the
 * #19 test pattern). This proves the bug at the actual emit site that
 * operators see, not just in the resolver in isolation.
 */

mockSessionsConfig();

const { sessionsCommand } = await import("./sessions.js");

type SessionsJsonPayload = {
  sessions?: Array<{
    key: string;
    model?: string | null;
    modelProvider?: string | null;
  }>;
};

const ACP_SESSION_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const NON_ACP_SESSION_KEY = "agent:copilot:main";

const AGENT_CONFIGURED_MODEL = "gpt-5.3-codex";
const AGENT_CONFIGURED_PROVIDER = "microsoft-foundry";

/**
 * Mock config with a `copilot` agent whose configured model is
 * `microsoft-foundry/gpt-5.3-codex` (the deployed scenario from the catalog).
 *
 * Both the ACP and the non-ACP session entries below leave `model` /
 * `modelProvider` unset, so `resolveSessionDisplayModelRef` falls through to
 * the agent's configured default. That is precisely the path under test:
 * for ACP sessions the agent default is the WRONG answer.
 */
function mockAgentConfigWithCopilotModel(): void {
  setMockSessionsConfig(() => ({
    agents: {
      list: [
        {
          id: "copilot",
          model: { primary: `${AGENT_CONFIGURED_PROVIDER}/${AGENT_CONFIGURED_MODEL}` },
        },
      ],
      defaults: {
        contextTokens: 200_000,
      },
    },
  }));
}

/**
 * ACP control-plane session entry: includes `entry.acp` as persisted by
 * `src/acp/control-plane/manager.core.ts:365` during acpx child init. The
 * presence of `entry.acp` is the discriminator the overlay uses to distinguish
 * real ACP child-runtime sessions from ACP bridge sessions.
 *
 * No `model` / `modelProvider` set on the entry — the listing falls through
 * to the agent's configured default, which is the buggy path for ACP keys.
 */
function buildAcpSessionEntry(): SessionEntry {
  return {
    sessionId: "acp-session-id",
    updatedAt: Date.now() - 2 * 60_000,
    acp: {
      backend: "copilot",
      agent: "copilot",
      runtimeSessionName: "acp-runtime-session-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now() - 2 * 60_000,
    },
  };
}

/**
 * ACP bridge session entry: ACP-shaped key but no `entry.acp`. The ACP bridge
 * (translator.ts) uses an in-memory-only session store and never writes
 * `SessionAcpMeta` to disk. If a bridge client passes an explicit ACP-shaped
 * key (e.g. `agent:copilot:acp:session-1`) and the Gateway persists the
 * session, it will have an ACP key without `entry.acp`. The overlay must NOT
 * fire for these sessions — they ran the configured model.
 */
function buildAcpBridgeSessionEntry(): SessionEntry {
  return {
    sessionId: "acp-bridge-session-id",
    updatedAt: Date.now() - 4 * 60_000,
    // No `acp` field: this is a bridge session, not a control-plane child session.
  };
}

/**
 * Minimal non-ACP session entry, same shape as the ACP bridge entry. Used as the
 * GREEN-control case below. The agent default is the correct answer for
 * non-ACP sessions — those run through the openclaw-agent-driven flow that
 * actually uses the configured model.
 */
function buildNonAcpSessionEntry(): SessionEntry {
  return {
    sessionId: "non-acp-session-id",
    updatedAt: Date.now() - 3 * 60_000,
  };
}

describe("sessionsCommand model/modelProvider display for ACP sessions (catalog #20)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
    mockAgentConfigWithCopilotModel();
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.useRealTimers();
  });

  it("RED: ACP control-plane session must NOT report the agent-configured model", async () => {
    // RED before fix. The session is a real ACP control-plane session
    // (key has the `:acp:` segment AND entry.acp is present), but
    // `resolveSessionDisplayModelRef` ignores both and returns the agent
    // default. Operators relying on `sessions --json` model fields see the
    // model the openclaw-agent-driven flow would have used, NOT what copilot
    // actually selected internally when it ran via ACP.
    //
    // The discriminator the fix uses: `isAcpSessionKey(row.key)` AND
    // `entry.acp != null` (persisted by the ACP control plane manager).
    const store = writeStore(
      { [ACP_SESSION_KEY]: buildAcpSessionEntry() },
      "sessions-acp-model-display-red",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_SESSION_KEY);

    expect(
      row,
      `Expected sessionsCommand --json to include a row for ${ACP_SESSION_KEY}; got none.`,
    ).toBeDefined();
    expect(
      row?.model,
      `ACP session ${ACP_SESSION_KEY} reports model="${row?.model}" — that is the agent-configured ` +
        `model (${AGENT_CONFIGURED_MODEL}), not what copilot actually used inside ACP. ` +
        `resolveSessionDisplayModelRef (src/commands/sessions-display-model.ts:123) has zero ` +
        `ACP-awareness; the call site at src/commands/sessions.ts should consult ` +
        `isAcpSessionKey(row.key) AND entry.acp != null, then overlay an ACP-runtime sentinel.`,
    ).not.toBe(AGENT_CONFIGURED_MODEL);
    expect(
      row?.modelProvider,
      `ACP session ${ACP_SESSION_KEY} reports modelProvider="${row?.modelProvider}" — the ` +
        `agent-configured provider (${AGENT_CONFIGURED_PROVIDER}), not the ACP runtime. ` +
        `Same fix site as above; the overlay must gate on entry.acp presence.`,
    ).not.toBe(AGENT_CONFIGURED_PROVIDER);
  });

  it("RED (fix-shape): ACP control-plane session should report the ACP runtime sentinel", async () => {
    // RED before fix; GREEN once the catalog-#20 sentinel-overlay fix lands.
    //
    // The catalog's chosen fix shape: when `isAcpSessionKey(row.key)` is true
    // AND `entry.acp != null`, overlay `{ provider: "acpx", model: "<agentId>-acp" }`.
    // This trades model-name accuracy for "this is ACP control-plane, not the
    // agent default" clarity. Plumbing the actual copilot-side model selection
    // into the openclaw record would require capturing ACP `session.model_change`
    // events (catalog notes this as deferrable).
    const store = writeStore(
      { [ACP_SESSION_KEY]: buildAcpSessionEntry() },
      "sessions-acp-model-display-fix-shape",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_SESSION_KEY);

    expect(row).toBeDefined();
    expect(
      row?.model,
      `ACP session ${ACP_SESSION_KEY} should resolve model to "copilot-acp" (the catalog-chosen ` +
        `sentinel). Got "${row?.model}". Fix gates on isAcpSessionKey(row.key) AND entry.acp != null ` +
        `and overlays { provider: "acpx", model: "copilot-acp" }. Keeps resolveSessionDisplayModelRef pure.`,
    ).toBe("copilot-acp");
    expect(
      row?.modelProvider,
      `ACP session ${ACP_SESSION_KEY} should resolve modelProvider to "acpx". Got ` +
        `"${row?.modelProvider}". Same fix as the model assertion above; the overlay sets both ` +
        `fields together so they remain internally consistent.`,
    ).toBe("acpx");
  });

  it("GREEN control: ACP bridge session (ACP key, no entry.acp) reports the configured model", async () => {
    // ACP bridge sessions (translator.ts) use ACP-shaped keys but never
    // persist SessionAcpMeta to disk. They run the normal configured model
    // and must NOT receive the acpx sentinel. This guards against a regression
    // where key-shape-only detection would misreport bridge sessions.
    const ACP_BRIDGE_SESSION_KEY = "agent:copilot:acp:bridge-session-1";
    const store = writeStore(
      { [ACP_BRIDGE_SESSION_KEY]: buildAcpBridgeSessionEntry() },
      "sessions-acp-model-display-bridge-control",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_BRIDGE_SESSION_KEY);

    expect(row).toBeDefined();
    expect(
      row?.model,
      `ACP bridge session ${ACP_BRIDGE_SESSION_KEY} has an ACP-shaped key but no entry.acp — ` +
        `it ran the configured model. Got model="${row?.model}"; expected "${AGENT_CONFIGURED_MODEL}". ` +
        `The overlay must gate on entry.acp != null, not key shape alone.`,
    ).toBe(AGENT_CONFIGURED_MODEL);
    expect(
      row?.modelProvider,
      `ACP bridge session ${ACP_BRIDGE_SESSION_KEY} should report the configured provider. ` +
        `Got "${row?.modelProvider}"; expected "${AGENT_CONFIGURED_PROVIDER}".`,
    ).toBe(AGENT_CONFIGURED_PROVIDER);
  });

  it("GREEN control: non-ACP session correctly reports the agent-configured model", async () => {
    // GREEN today. The same agent configuration drives a non-ACP session
    // (`agent:copilot:main`) — and for that session the agent-configured
    // model IS the right answer because the openclaw-agent-driven flow
    // actually runs that model. This control proves:
    //   1. The test infrastructure is exercising the real resolver path
    //      (not a mock that would silently pass either way).
    //   2. The configured-model branch of resolveSessionDisplayModelRef
    //      remains correct for non-ACP keys; the proposed sentinel overlay
    //      must NOT break this case (it should only fire when both
    //      isAcpSessionKey(row.key) is true AND entry.acp is present).
    const store = writeStore(
      { [NON_ACP_SESSION_KEY]: buildNonAcpSessionEntry() },
      "sessions-acp-model-display-green-control",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === NON_ACP_SESSION_KEY);

    expect(row).toBeDefined();
    expect(row?.model).toBe(AGENT_CONFIGURED_MODEL);
    expect(row?.modelProvider).toBe(AGENT_CONFIGURED_PROVIDER);
  });
});
