// Native hook relay CLI tests cover relay command registration and runtime delegation.
import { describe, expect, it, vi } from "vitest";
import {
  createReadableTextStream,
  createWritableTextBuffer,
  runNativeHookRelayCli,
} from "./native-hook-relay-cli.js";

describe("native hook relay CLI", () => {
  it("reads Codex hook JSON from stdin and forwards it to the gateway relay", async () => {
    const callGateway = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1234",
      },
      {
        stdin: createReadableTextStream(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "pnpm test" },
          }),
        ),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
    expect(callGateway).toHaveBeenCalledWith({
      method: "nativeHook.invoke",
      params: {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      },
      timeoutMs: 1234,
      scopes: ["operator.admin"],
    });
  });

  it("renders provider-compatible stdout, stderr, and exit code from the gateway response", async () => {
    const callGateway = vi.fn(async () => ({ stdout: "out", stderr: "err", exitCode: 2 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("out");
    expect(stderr.text()).toBe("err");
  });

  it("rejects malformed timeouts before reading relay input", async () => {
    const invokeBridge = vi.fn();
    const callGateway = vi.fn();
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "5000ms",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("invalid native hook timeout");
    expect(stderr.text()).toContain('Received: "5000ms"');
    expect(invokeBridge).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rejects fractional timeouts before gateway fallback", async () => {
    const invokeBridge = vi.fn();
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1.5",
      },
      {
        stdin: createReadableTextStream("{}"),
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain('Received: "1.5"');
    expect(invokeBridge).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("renders unavailable output for legacy relay commands without a generation", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error("generation must be non-empty string");
    });
    const callGateway = vi.fn(async () => {
      throw new Error("generation must be non-empty string");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
    expect(stderr.text()).toContain("generation must be non-empty string");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nativeHook.invoke",
        params: expect.objectContaining({ generation: undefined }),
      }),
    );
  });

  it.each([
    {
      event: "pre_tool_use",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay unavailable",
        },
      },
    },
    {
      event: "permission_request",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Native hook relay unavailable",
          },
        },
      },
    },
    {
      event: "post_tool_use",
      stdout: null,
    },
  ])(
    "does not fall back to the gateway after a stale direct bridge error for $event",
    async (testCase) => {
      const invokeBridge = vi.fn(async () => {
        throw new Error("native hook relay bridge stale registration");
      });
      const callGateway = vi.fn(async () => ({ stdout: "unexpected", stderr: "", exitCode: 0 }));
      const stdout = createWritableTextBuffer();
      const stderr = createWritableTextBuffer();

      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          generation: "generation-1",
          event: testCase.event,
        },
        {
          stdin: createReadableTextStream("{}"),
          stdout,
          stderr,
          invokeBridge: invokeBridge as never,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      if (testCase.stdout) {
        expect(JSON.parse(stdout.text())).toEqual(testCase.stdout);
      } else {
        expect(stdout.text()).toBe("");
      }
      expect(stderr.text()).toContain("native hook relay unavailable");
      expect(stderr.text()).toContain("native hook relay bridge stale registration");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("returns a nonzero code for malformed hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{nope"),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("failed to read native hook input");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rejects oversized hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "post_tool_use" },
      {
        stdin: createReadableTextStream("x".repeat(1024 * 1024 + 1)),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("native hook input exceeds");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails closed for PreToolUse when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("keeps PreToolUse unavailable handling observational only with an explicit no-policy marker", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        preToolUseUnavailable: "noop",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("fails closed for PermissionRequest when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Native hook relay unavailable",
        },
      },
    });
  });

  it("keeps PostToolUse unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "post_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("keeps before_agent_finalize unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "before_agent_finalize",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });
});
