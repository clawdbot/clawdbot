import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../../plugins/runtime.js";
import { registerAgentHarness } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import {
  consumeTranscriptBytePreflightClaim,
  resolveTranscriptBytePreflightAuthority,
  setTranscriptBytePreflightClaim,
} from "./transcript-byte-preflight-authority.js";

const sessionTarget: SessionTranscriptRuntimeTarget = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  storePath: "/tmp/sessions.json",
};
type ConsumeOverrides = {
  lockedHarnessRuntime?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  preflightRequired?: boolean;
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
};

function makeCodexHarness(): AgentHarness {
  return {
    id: "codex",
    label: "Codex",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("not used");
    },
  };
}

describe("transcript-byte preflight authority", () => {
  let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  let registry = createEmptyPluginRegistry();
  let authority: NonNullable<ReturnType<typeof resolveTranscriptBytePreflightAuthority>>;

  beforeEach(() => {
    snapshot = captureActivePluginRegistrySnapshot();
    registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    withPluginRegistrationContext(registry, "codex", () => {
      registerAgentHarness(makeCodexHarness(), {
        nativeCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
      });
    });
    const harness = expectDefined(registry.agentHarnesses[0]?.harness, "registered Codex harness");
    authority = expectDefined(
      resolveTranscriptBytePreflightAuthority(harness),
      "transcript-byte preflight authority",
    );
  });

  afterEach(() => {
    restoreActivePluginRegistrySnapshot(snapshot);
  });

  function consume(runtimeContext: ContextEngineRuntimeContext, overrides: ConsumeOverrides = {}) {
    return consumeTranscriptBytePreflightClaim(
      {
        contextEngineRuntimeContext: runtimeContext,
        sessionId: sessionTarget.sessionId,
        workspaceDir: "/tmp/workspace",
        preflightRequired: overrides.preflightRequired ?? true,
        preflightCompactionTrigger: overrides.preflightCompactionTrigger ?? "transcript_bytes",
        trigger: "budget",
      },
      overrides.sessionTarget ?? sessionTarget,
      overrides.lockedHarnessRuntime ?? "codex",
    );
  }

  it("consumes the exact runtime-context claim once", () => {
    const runtimeContext = { sessionTarget };
    const clearClaim = setTranscriptBytePreflightClaim(runtimeContext, authority);

    expect(consume(runtimeContext)).toMatchObject({
      authority,
      sessionTarget,
    });
    expect(consume(runtimeContext)).toBeUndefined();
    clearClaim();
  });

  it("rejects the same runtime context after its session target changes", () => {
    const runtimeContext: ContextEngineRuntimeContext = {
      sessionTarget: { ...sessionTarget },
    };
    setTranscriptBytePreflightClaim(runtimeContext, authority);
    const replacementTarget = { ...sessionTarget, sessionId: "session-2" };
    runtimeContext.sessionTarget = replacementTarget;

    expect(consume(runtimeContext, { sessionTarget: replacementTarget })).toBeUndefined();
  });

  it.each([
    { name: "forged public state", runtimeContext: { hostOwnsTranscriptBytePreflight: true } },
    {
      name: "wrong owner",
      runtimeContext: {},
      overrides: { lockedHarnessRuntime: "openclaw" },
    },
    {
      name: "wrong target",
      runtimeContext: {},
      overrides: { sessionTarget: { ...sessionTarget, sessionId: "session-2" } },
    },
    {
      name: "token trigger",
      runtimeContext: {},
      overrides: { preflightCompactionTrigger: "tokens" },
    },
  ] satisfies Array<{
    name: string;
    runtimeContext: ContextEngineRuntimeContext;
    overrides?: ConsumeOverrides;
  }>)("rejects $name", ({ runtimeContext, overrides }) => {
    setTranscriptBytePreflightClaim(runtimeContext, authority);
    expect(consume(runtimeContext, overrides)).toBeUndefined();
  });

  it("retains the exact claim across wrapper delegation", () => {
    const runtimeContext = { sessionTarget };
    const wrapper = () => consume(runtimeContext);
    const withCompactionPersistence = vi.fn(() => "compaction-entry");

    setTranscriptBytePreflightClaim(runtimeContext, authority, withCompactionPersistence);
    expect(wrapper()).toMatchObject({
      authority,
      sessionTarget,
      withCompactionPersistence,
    });
    expect(wrapper()).toBeUndefined();
  });
});
