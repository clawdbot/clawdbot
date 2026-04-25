import type { NativeHookRelayRegistrationHandle } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayDisabledConfig,
} from "./native-hook-relay.js";

describe("Codex native hook relay config", () => {
  it("builds deterministic Codex config overrides with command hooks", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      hookTimeoutSec: 7,
    });

    expect(config).toEqual({
      "features.codex_hooks": true,
      "hooks.PreToolUse": [
        {
          matcher: null,
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --event pre_tool_use",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [
        {
          matcher: null,
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --event post_tool_use",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PermissionRequest": [
        {
          matcher: null,
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --event permission_request",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(config)).not.toContain("timeoutSec");
    expect(config).not.toHaveProperty("hooks.SessionStart");
    expect(config).not.toHaveProperty("hooks.UserPromptSubmit");
    expect(config).not.toHaveProperty("hooks.Stop");
  });

  it("includes only requested hook events", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
      }),
    ).toEqual({
      "features.codex_hooks": true,
      "hooks.PermissionRequest": [
        {
          matcher: null,
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --event permission_request",
              timeout: 5,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
    });
  });

  it("builds deterministic clearing config when the relay is disabled", () => {
    expect(buildCodexNativeHookRelayDisabledConfig()).toEqual({
      "features.codex_hooks": false,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
    });
  });
});

function createRelay(): NativeHookRelayRegistrationHandle {
  return {
    relayId: "relay-1",
    provider: "codex",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    allowedEvents: ["pre_tool_use", "post_tool_use", "permission_request"],
    expiresAtMs: Date.now() + 1000,
    commandForEvent: (event) =>
      `openclaw hooks relay --provider codex --relay-id relay-1 --event ${event}`,
    unregister: () => undefined,
  };
}
