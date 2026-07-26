// Google Meet node.invoke policy tests cover caller-controlled command sanitization.
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import {
  createGoogleMeetChromeNodeInvokePolicy,
  GOOGLE_MEET_CHROME_NODE_COMMAND,
} from "./node-invoke-policy.js";

function createContext(params: unknown, pluginConfig: Record<string, unknown> = {}) {
  const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
    ok: true,
    payload: { ok: true },
  }));
  const ctx: OpenClawPluginNodeInvokePolicyContext = {
    nodeId: "node-1",
    command: GOOGLE_MEET_CHROME_NODE_COMMAND,
    params,
    config: {} as never,
    pluginConfig,
    invokeNode,
  };
  return { ctx, invokeNode };
}

describe("Google Meet node invoke policy", () => {
  it("rewrites start executable fields from trusted config", async () => {
    const policy = createGoogleMeetChromeNodeInvokePolicy(
      resolveGoogleMeetConfig({
        chrome: {
          launch: false,
          browserProfile: "Trusted Profile",
          joinTimeoutMs: 45_000,
          audioInputCommand: ["trusted-capture", "--raw"],
          audioOutputCommand: ["trusted-play", "--raw"],
        },
      }),
    );
    const { ctx, invokeNode } = createContext({
      action: "start",
      url: "https://meet.google.com/abc-defg-hij",
      mode: "bidi",
      launch: true,
      browserProfile: "Attacker Profile",
      joinTimeoutMs: 1,
      audioBridgeCommand: ["node", "-e", "process.exit(99)"],
      audioBridgeHealthCommand: ["node", "-e", "process.exit(98)"],
      audioInputCommand: ["malicious-capture"],
      audioOutputCommand: ["malicious-play"],
    });

    await expect(policy.handle(ctx)).resolves.toEqual({ ok: true, payload: { ok: true } });

    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "start",
        url: "https://meet.google.com/abc-defg-hij",
        mode: "bidi",
        launch: false,
        browserProfile: "Trusted Profile",
        joinTimeoutMs: 45_000,
        audioInputCommand: ["trusted-capture", "--raw"],
        audioOutputCommand: ["trusted-play", "--raw"],
      },
    });
  });

  it("uses trusted configured external bridge commands for start", async () => {
    const policy = createGoogleMeetChromeNodeInvokePolicy(
      resolveGoogleMeetConfig({
        chrome: {
          audioBridgeHealthCommand: ["trusted-bridge", "status"],
          audioBridgeCommand: ["trusted-bridge", "start"],
        },
      }),
    );
    const { ctx, invokeNode } = createContext({
      action: "start",
      url: "https://meet.google.com/abc-defg-hij",
      mode: "bidi",
      audioBridgeHealthCommand: ["node", "-e", "process.exit(98)"],
      audioBridgeCommand: ["node", "-e", "process.exit(99)"],
    });

    await policy.handle(ctx);

    const call = invokeNode.mock.calls[0]?.[0];
    expect(call?.params).toMatchObject({
      action: "start",
      audioBridgeHealthCommand: ["trusted-bridge", "status"],
      audioBridgeCommand: ["trusted-bridge", "start"],
    });
  });

  it("rejects direct start for non-Meet URLs before node dispatch", async () => {
    const policy = createGoogleMeetChromeNodeInvokePolicy(resolveGoogleMeetConfig({}));
    const { ctx, invokeNode } = createContext({
      action: "start",
      url: "https://example.com/private",
      mode: "bidi",
    });

    await expect(policy.handle(ctx)).resolves.toMatchObject({
      ok: false,
      code: "GOOGLE_MEET_NODE_POLICY_DENIED",
      message: "url must be an explicit https://meet.google.com/... URL",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("keeps direct setup diagnostics but strips extra fields", async () => {
    const policy = createGoogleMeetChromeNodeInvokePolicy(resolveGoogleMeetConfig({}));
    const { ctx, invokeNode } = createContext({
      action: "setup",
      audioBridgeCommand: ["node", "-e", "process.exit(99)"],
    });

    await policy.handle(ctx);

    expect(invokeNode).toHaveBeenCalledWith({ params: { action: "setup" } });
  });

  it("rejects malformed bridge control before node dispatch", async () => {
    const policy = createGoogleMeetChromeNodeInvokePolicy(resolveGoogleMeetConfig({}));

    for (const params of [
      { action: "pullAudio" },
      { action: "pushAudio", bridgeId: "bridge-1" },
      { action: "pushAudio", bridgeId: "bridge-1", base64: "not-base64!" },
      { action: "clearAudio", bridgeId: "" },
      { action: "stopByUrl" },
      { action: "stopByUrl", url: "https://example.com/not-meet" },
    ]) {
      const { ctx, invokeNode } = createContext(params);

      await expect(policy.handle(ctx)).resolves.toMatchObject({
        ok: false,
        code: "GOOGLE_MEET_NODE_POLICY_DENIED",
      });
      expect(invokeNode).not.toHaveBeenCalled();
    }
  });

  it("normalizes forwarded Meet URL filters before node dispatch", async () => {
    const policy = createGoogleMeetChromeNodeInvokePolicy(resolveGoogleMeetConfig({}));
    const { ctx, invokeNode } = createContext({
      action: "stopByUrl",
      url: "https://meet.google.com/abc-defg-hij?authuser=1",
      mode: "agent",
      exceptBridgeId: "bridge-1",
      audioBridgeCommand: ["node", "-e", "process.exit(99)"],
    });

    await policy.handle(ctx);

    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "stopByUrl",
        url: "https://meet.google.com/abc-defg-hij?authuser=1",
        mode: "agent",
        exceptBridgeId: "bridge-1",
      },
    });
  });

  it("rejects unsupported googlemeet.chrome actions before node dispatch", async () => {
    const policy = createGoogleMeetChromeNodeInvokePolicy(resolveGoogleMeetConfig({}));
    const { ctx, invokeNode } = createContext({ action: "exec", command: ["id"] });

    await expect(policy.handle(ctx)).resolves.toMatchObject({
      ok: false,
      code: "GOOGLE_MEET_NODE_POLICY_DENIED",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});
