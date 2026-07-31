// Codex tests cover the native hook relay approval-policy guard.
import {
  embeddedAgentLog,
  type NativeHookRelayEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawExecPolicyForCodexAppServer } from "./config-contracts.js";
import {
  resolveCodexAppServerNativeHookRelay,
  resolveCodexAppServerRuntimeOptions,
} from "./config.js";
import { resolveCodexNativeHookRelayForApprovalPolicy } from "./native-hook-relay.js";

const FLOOR = ["pre_tool_use"] as const;
const GRANULAR = {
  granular: {
    mcp_elicitations: true,
    request_permissions: false,
    rules: false,
    sandbox_approval: false,
    skill_approval: false,
  },
} as const;

type GuardApprovalPolicy = Parameters<
  typeof resolveCodexNativeHookRelayForApprovalPolicy
>[0]["approvalPolicy"];

// Generic, so extra passthrough fields (ttl, timeouts) survive excess-property
// checking exactly as they do at the real call sites.
function guard<T extends { enabled?: boolean; events?: readonly NativeHookRelayEvent[] }>(
  requested: T | undefined,
  approvalPolicy: GuardApprovalPolicy,
  warn?: (message: string, meta: Record<string, unknown>) => void,
) {
  return resolveCodexNativeHookRelayForApprovalPolicy({
    requested,
    approvalPolicy,
    ...(warn ? { warn } : {}),
  });
}

describe("resolveCodexNativeHookRelayForApprovalPolicy", () => {
  afterEach(() => {
    resetGlobalHookRunner();
  });

  it('honors the requested shape verbatim when the effective policy is "never"', () => {
    const warn = vi.fn();
    // Full kill-switch: approvals off and no before-tool policy to enforce.
    expect(guard({ enabled: false }, "never", warn)).toStrictEqual({ enabled: false });
    expect(guard({ enabled: false, events: ["post_tool_use"] }, "never", warn)).toStrictEqual({
      enabled: false,
      events: ["post_tool_use"],
    });
    // Scopes are authoritative, including one without the floor.
    expect(guard({ enabled: true, events: ["post_tool_use"] }, "never", warn)).toStrictEqual({
      enabled: true,
      events: ["post_tool_use"],
    });
    // `permission_request` is honored as authored: nothing owns escalation here.
    expect(guard({ enabled: true, events: ["permission_request"] }, "never", warn)).toStrictEqual({
      enabled: true,
      events: ["permission_request"],
    });
    expect(guard(undefined, "never", warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes an explicit events scope through verbatim under every policy", () => {
    const warn = vi.fn();
    // Explicit scopes are upstream's contract, not this config surface's to edit:
    // #116117 deliberately keeps an explicit permission_request relay alive under
    // a prompting policy (pinned in run-attempt.native-hook-relay.test.ts).
    for (const approvalPolicy of ["on-request", "untrusted", "never"] as const) {
      expect(
        guard({ enabled: true, events: ["permission_request"] }, approvalPolicy, warn),
      ).toStrictEqual({ enabled: true, events: ["permission_request"] });
      expect(
        guard({ enabled: true, events: ["post_tool_use"] }, approvalPolicy, warn),
      ).toStrictEqual({ enabled: true, events: ["post_tool_use"] });
    }
    // A scope is never reordered, deduplicated, or floored.
    expect(
      guard({ enabled: true, events: ["permission_request", "post_tool_use"] }, "on-request", warn),
    ).toStrictEqual({ enabled: true, events: ["permission_request", "post_tool_use"] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("retains the before-tool policy relay when a policy is active under an explicit never", () => {
    // Explicit yolo/never with a live before_tool_call hook: emitting
    // `features.hooks: false` here would drop the very relay that executes and can
    // block that policy, so the opt-out narrows to the floor instead.
    const warn = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );

    expect(guard({ enabled: false }, "never", warn)).toStrictEqual({
      enabled: true,
      events: [...FLOOR],
    });
    expect(warn).toHaveBeenCalledWith(
      "codex native hook relay opt-out (enabled: false) narrowed to events [pre_tool_use]: " +
        "an active OpenClaw before-tool policy (before_tool_call hook or trusted-tool policy) " +
        "requires the before-tool policy relay; a full opt-out needs approvals off and no " +
        "before-tool policy",
      {
        approvalPolicy: "never",
        beforeToolPolicyActive: true,
        requested: { enabled: false, events: undefined },
        resolved: { enabled: true, events: ["pre_tool_use"] },
      },
    );
  });

  it("still honors the full kill-switch once the before-tool policy is gone", () => {
    // The converse of the case above, proving the check reads live policy state
    // rather than a one-time decision.
    const warn = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([]));

    expect(guard({ enabled: false }, "never", warn)).toStrictEqual({ enabled: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("narrows an opt-out to the before-tool policy relay under a prompting policy", () => {
    const warn = vi.fn();
    for (const approvalPolicy of ["on-request", "untrusted"] as const) {
      expect(guard({ enabled: false }, approvalPolicy, warn)).toStrictEqual({
        enabled: true,
        events: [...FLOOR],
      });
    }
    // Any `events` scope is subsumed by the opt-out. It renders the same message
    // as the plain opt-out, so it is deduped on purpose: one operative fact.
    expect(guard({ enabled: false, events: ["post_tool_use"] }, "on-request", warn)).toStrictEqual({
      enabled: true,
      events: [...FLOOR],
    });
    // Two distinct effective policies, two lines; the repeat adds nothing.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "codex native hook relay opt-out (enabled: false) narrowed to events [pre_tool_use]: " +
        'effective approval policy "on-request" requires the before-tool policy relay; approvals ' +
        'must be off (effective approvalPolicy "never") for a full opt-out',
      {
        approvalPolicy: "on-request",
        beforeToolPolicyActive: false,
        requested: { enabled: false, events: undefined },
        resolved: { enabled: true, events: ["pre_tool_use"] },
      },
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('effective approval policy "untrusted"'),
      expect.objectContaining({ approvalPolicy: "untrusted" }),
    );
  });

  it("passes through unchanged when no scope is set", () => {
    const warn = vi.fn();
    expect(guard({ enabled: true }, "on-request", warn)).toStrictEqual({ enabled: true });
    expect(guard({ enabled: true, events: [] }, "on-request", warn)).toStrictEqual({
      enabled: true,
      events: [],
    });
    expect(guard(undefined, "on-request", warn)).toBeUndefined();
    expect(guard(undefined, "never", warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves fields beyond enabled/events while narrowing", () => {
    const warn = vi.fn();
    expect(
      guard(
        { enabled: false, ttlMs: 1_234, gatewayTimeoutMs: 42, hookTimeoutSec: 7 },
        "on-request",
        warn,
      ),
    ).toStrictEqual({
      enabled: true,
      events: [...FLOOR],
      ttlMs: 1_234,
      gatewayTimeoutMs: 42,
      hookTimeoutSec: 7,
    });
  });

  it("falls back to embeddedAgentLog.warn when no sink is injected, including granular", () => {
    // The run paths call the guard without `warn`, so the default sink is the only
    // thing that surfaces an override in production. A granular policy prompts, so
    // the opt-out narrows there too. Unique message: the dedupe set is
    // module-global and no other test uses the granular policy.
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    try {
      expect(
        resolveCodexNativeHookRelayForApprovalPolicy({
          requested: { enabled: false },
          approvalPolicy: GRANULAR,
        }),
      ).toStrictEqual({ enabled: true, events: ["pre_tool_use"] });

      expect(warn.mock.calls).toEqual([
        [
          "codex native hook relay opt-out (enabled: false) narrowed to events [pre_tool_use]: " +
            "effective approval policy granular requires the before-tool policy relay; approvals " +
            'must be off (effective approvalPolicy "never") for a full opt-out',
          {
            approvalPolicy: GRANULAR,
            beforeToolPolicyActive: false,
            requested: { enabled: false, events: undefined },
            resolved: { enabled: true, events: ["pre_tool_use"] },
          },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("native hook relay guard against forced runtime policies", () => {
  const optOutPluginConfig = {
    appServer: { approvalPolicy: "never", nativeHookRelay: { enabled: false } },
  };

  // `touched` + a non-"full" mode makes `forceUserReviewerForExecMode` true.
  // `security`/`ask` are deliberately not the full/always pair, so the separate
  // `forceDangerFullAccessSandbox` path stays out of this test.
  const execPolicyForcingPromptingApprovals: OpenClawExecPolicyForCodexAppServer = {
    mode: "ask",
    security: "allowlist",
    ask: "on-miss",
    touched: true,
  };

  function resolveEffectiveAppServer(params: {
    execPolicy?: OpenClawExecPolicyForCodexAppServer;
    pluginConfig?: unknown;
  }) {
    return resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      pluginConfig: params.pluginConfig ?? optOutPluginConfig,
      ...(params.execPolicy ? { execPolicy: params.execPolicy } : {}),
    });
  }

  it("keeps the full kill-switch when nothing forces a prompting policy", () => {
    const appServer = resolveEffectiveAppServer({});
    expect(appServer.approvalPolicy).toBe("never");

    const requested = resolveCodexAppServerNativeHookRelay(optOutPluginConfig);
    expect(requested).toStrictEqual({ enabled: false });
    expect(
      resolveCodexNativeHookRelayForApprovalPolicy({
        requested,
        approvalPolicy: appServer.approvalPolicy,
        warn: vi.fn(),
      }),
    ).toStrictEqual({ enabled: false });
  });

  it("narrows instead of disabling when the runtime forces a prompting policy", () => {
    // `resolveCodexAppServerRuntimeOptions` can force a prompting policy over a
    // configured "never" (unknown-model or exec-mode reviewer forcing, forced
    // guardian reviewer, forced danger-full-access sandbox). The guard must see
    // the forced value, not the configured one.
    const appServer = resolveEffectiveAppServer({
      execPolicy: execPolicyForcingPromptingApprovals,
    });
    expect(appServer.approvalPolicy).toBe("on-request");

    const requested = resolveCodexAppServerNativeHookRelay(optOutPluginConfig);
    expect(requested).toStrictEqual({ enabled: false });
    expect(
      resolveCodexNativeHookRelayForApprovalPolicy({
        requested,
        approvalPolicy: appServer.approvalPolicy,
        warn: vi.fn(),
      }),
    ).toStrictEqual({ enabled: true, events: ["pre_tool_use"] });
  });
});
