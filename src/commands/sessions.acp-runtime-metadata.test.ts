import { describe, expect, it } from "vitest";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

/**
 * Catalog #18 — `openclaw sessions --json` reports `agentRuntime.id: "pi"` for
 * ACP sessions because `resolveAgentRuntimeMetadata` only consults agent-config
 * policies (env / agent / defaults / implicit fallback to "pi"). The session
 * key clearly carries the ACP runtime indicator (the `:acp:` segment), but
 * `sessions.ts:294` ignores it and just calls `resolveAgentRuntimeMetadata(cfg, agentId)`.
 *
 * Empirical observation from a deployed openclaw container against a copilot
 * agent that has no explicit `agentRuntime.id` policy:
 *
 *   {
 *     "key": "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9",
 *     "agentId": "copilot",
 *     "agentRuntime": { "id": "pi", "source": "implicit" },
 *     "kind": "direct"
 *   }
 *
 * That is wrong: this session is plainly ACP, not PI. The runtime field is
 * supposed to be a faithful classifier of how this session is actually being
 * run; instead, every ACP session in the JSON output is mislabelled as `pi`.
 *
 * This test mirrors the exact computation `sessionsCommand` performs at
 * `src/commands/sessions.ts:294` and proves the bug in two parts:
 *
 *   - RED: ACP-keyed session resolves to `id: "pi"`, `source: "implicit"`.
 *   - GREEN control: a non-ACP `agent:main:main` session resolves to the
 *     same implicit-pi metadata, which IS correct in that case. The control
 *     proves the assertion infrastructure is not masking the RED case.
 *
 * Fix shape (see the third test): when the session key is ACP-style,
 * agentRuntime.id should report `acpx` (or whatever runtime id is actually
 * driving the session) so that the JSON faithfully classifies the session.
 * The fix likely belongs at the caller (sessions.ts:294 and the other
 * call sites in `src/gateway/server-methods/sessions.ts`,
 * `src/gateway/session-utils.ts`) so it can pass session-key context to
 * `resolveAgentRuntimeMetadata`, OR `resolveAgentRuntimeMetadata` itself
 * gains an optional `sessionKey` parameter and applies a session-key-aware
 * override.
 */

const ACP_SESSION_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const NON_ACP_SESSION_KEY = "agent:main:main";

/**
 * Build a minimal `OpenClawConfig` that mirrors the deployed scenario:
 * - a copilot agent exists in the agents.list
 * - it has NO explicit `agentRuntime.id` policy
 * - no top-level `agents.defaults.agentRuntime` either
 *
 * Result: `resolveAgentRuntimeMetadata(cfg, "copilot")` falls through to the
 * implicit "pi" branch — which is the bug under test.
 */
function buildConfigWithoutAgentRuntimePolicy(): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "copilot",
          // Intentionally no `agentRuntime` field, no `runtime` descriptor.
        },
        {
          id: "main",
        },
      ],
      // No `defaults.agentRuntime` either.
      defaults: {},
    },
  } as OpenClawConfig;
}

/**
 * Mirror the per-row computation from `src/commands/sessions.ts:290-298`:
 *   const agentId = parseAgentSessionKey(row.key)?.agentId ?? target.agentId;
 *   const agentRuntime = resolveModelAgentRuntimeMetadata({ cfg, agentId, sessionKey: row.key });
 *
 * Returns the same shape that ends up serialized to `--json` output.
 * After commit 02fe0d8978, the production path goes through resolveModelAgentRuntimeMetadata
 * (not resolveAgentRuntimeMetadata which is now a stub returning { id: "auto", source: "implicit" }).
 */
function computeSessionAgentRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  fallbackAgentId: string;
  /** Mirrors `entry?.acp != null` passed from loaded session rows. */
  acpRuntime?: boolean;
  /** Mirrors `entry?.acp?.backend` passed from the session store entry. */
  acpBackend?: string;
}): ReturnType<typeof resolveModelAgentRuntimeMetadata> {
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId ?? params.fallbackAgentId;
  return resolveModelAgentRuntimeMetadata({
    cfg: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    acpRuntime: params.acpRuntime,
    acpBackend: params.acpBackend,
  });
}

describe("sessions --json agentRuntime classifier (catalog #18)", () => {
  it("RED→GREEN: ACP session key is no longer misclassified (overlay applies)", () => {
    const cfg = buildConfigWithoutAgentRuntimePolicy();
    const agentRuntime = computeSessionAgentRuntime({
      cfg,
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
    });

    // The bug was: the session key plainly contains `:acp:` and yet the
    // resolved metadata said id="pi", source="implicit".
    // After the fix (applyAcpRuntimeOverlay in resolveModelAgentRuntimeMetadata),
    // the ACP session key overrides the runtime to id="acpx", source="session-key".
    expect(
      agentRuntime.id,
      `ACP session ${ACP_SESSION_KEY} should no longer be misclassified as "auto" or "pi". ` +
        `Got "${agentRuntime.id}". resolveModelAgentRuntimeMetadata must pass sessionKey to ` +
        `applyAcpRuntimeOverlay so ACP sessions are classified as "acpx".`,
    ).not.toBe("auto");
    expect(
      agentRuntime.source,
      `ACP session ${ACP_SESSION_KEY} resolved with source="${agentRuntime.source}". ` +
        `For an ACP-keyed session, the source should not be "implicit" — ` +
        `the session key itself is an explicit signal that the runtime is ACP.`,
    ).not.toBe("implicit");
  });

  it("GREEN control: non-ACP session is NOT overridden by ACP overlay", () => {
    const cfg = buildConfigWithoutAgentRuntimePolicy();
    const agentRuntime = computeSessionAgentRuntime({
      cfg,
      sessionKey: NON_ACP_SESSION_KEY,
      fallbackAgentId: "main",
    });

    // For a non-ACP session, the overlay must NOT fire — the result must
    // not be "acpx" and source must not be "session-key".  The control
    // proves the overlay is gated on the `:acp:` segment in the session key.
    // (The concrete id — "codex" for the default openai/gpt-5.5 provider —
    // is determined by resolveAgentHarnessPolicy's Codex-routing rule;
    // what matters here is the absence of the ACP override.)
    expect(agentRuntime.id).not.toBe("acpx");
    expect(agentRuntime.source).not.toBe("session-key");
  });

  it("FIX-SHAPE expectation: ACP session should resolve to 'acpx'", () => {
    // What "fixed" should look like once the bug is addressed.
    // RED today; GREEN once the fix lands.
    //
    // Note: the exact id ("acpx" vs another label) is a design choice for
    // the fix author. What matters is that it is meaningfully different
    // from "pi" and reflects the actual runtime driving the session.
    // If the fix picks a different label, update this assertion to match —
    // the structural point (session-key-aware classification) is the
    // load-bearing part.
    const cfg = buildConfigWithoutAgentRuntimePolicy();
    const agentRuntime = computeSessionAgentRuntime({
      cfg,
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
    });

    expect(
      agentRuntime.id,
      `ACP session ${ACP_SESSION_KEY} should resolve to runtime id "acpx" (or the canonical ACP runtime label). ` +
        `Got "${agentRuntime.id}". Fix candidates: ` +
        `(a) override at the call site in src/commands/sessions.ts:294 once isAcpSessionKey(row.key) is true, or ` +
        `(b) extend resolveAgentRuntimeMetadata to accept an optional sessionKey and apply the override centrally.`,
    ).toBe("acpx");
  });

  it("backend override: ACP session with entry.acp.backend set reports that backend id, NOT 'acpx'", () => {
    // When the session entry carries an explicit acp.backend (e.g. a registered
    // non-default backend), the overlay must reflect the actual backend instead
    // of the generic "acpx" fallback.
    const cfg = buildConfigWithoutAgentRuntimePolicy();
    const agentRuntime = computeSessionAgentRuntime({
      cfg,
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
      acpBackend: "custom-backend",
    });

    expect(agentRuntime.id).toBe("custom-backend");
    expect(agentRuntime.source).toBe("session-key");
  });

  it("backend fallback: ACP session with entry.acp but no backend falls back to 'acpx'", () => {
    // When the session entry has ACP metadata but no acp.backend, the overlay
    // must fall back to the canonical "acpx" id.
    const cfg = buildConfigWithoutAgentRuntimePolicy();
    const agentRuntime = computeSessionAgentRuntime({
      cfg,
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
      // acpBackend intentionally omitted — mirrors entry with no acp.backend
    });

    expect(agentRuntime.id).toBe("acpx");
    expect(agentRuntime.source).toBe("session-key");
  });

  it("GREEN control: ACP-shaped bridge session without entry.acp is NOT overridden", () => {
    const cfg = buildConfigWithoutAgentRuntimePolicy();
    const agentRuntime = computeSessionAgentRuntime({
      cfg,
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: false,
    });

    expect(agentRuntime.id).not.toBe("acpx");
    expect(agentRuntime.source).not.toBe("session-key");
  });
});
