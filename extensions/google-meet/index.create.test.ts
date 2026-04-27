import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { __testing as googleMeetPluginTesting } from "./index.js";
import { registerGoogleMeetCli } from "./src/cli.js";
import { resolveGoogleMeetConfig } from "./src/config.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import {
  captureStdout,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { CREATE_MEET_FROM_BROWSER_SCRIPT } from "./src/transports/chrome-create.js";

const voiceCallMocks = vi.hoisted(() => ({
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({ callId: "call-1", dtmfSent: true })),
  endMeetVoiceCallGatewayCall: vi.fn(async () => {}),
}));

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
    }): Promise<{
      response: Response;
      release: () => Promise<void>;
    }> => ({
      response: await fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
}));

vi.mock("./src/voice-call-gateway.js", () => ({
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
  endMeetVoiceCallGatewayCall: voiceCallMocks.endMeetVoiceCallGatewayCall,
}));

function setup(
  config?: Parameters<typeof setupGoogleMeetPlugin>[1],
  options?: Parameters<typeof setupGoogleMeetPlugin>[2],
) {
  const harness = setupGoogleMeetPlugin(plugin, config, options);
  googleMeetPluginTesting.setCallGatewayFromCliForTests(
    async (method, _opts, params) =>
      (await invokeGoogleMeetGatewayMethodForTest(harness.methods, method, params)) as Record<
        string,
        unknown
      >,
  );
  return harness;
}

async function runCreateMeetBrowserScript(params: { buttonText: string }) {
  const location = {
    href: "https://meet.google.com/new",
    hostname: "meet.google.com",
  };
  const button = {
    disabled: false,
    innerText: params.buttonText,
    textContent: params.buttonText,
    getAttribute: (name: string) => (name === "aria-label" ? params.buttonText : null),
    click: vi.fn(() => {
      location.href = "https://meet.google.com/abc-defg-hij";
    }),
  };
  const document = {
    title: "Meet",
    body: {
      innerText: "Do you want people to hear you in the meeting?",
      textContent: "Do you want people to hear you in the meeting?",
    },
    querySelectorAll: (selector: string) => (selector === "button" ? [button] : []),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", location);
  const fn = (0, eval)(`(${CREATE_MEET_FROM_BROWSER_SCRIPT})`) as () => Promise<{
    meetingUri?: string;
    manualActionReason?: string;
    notes?: string[];
    retryAfterMs?: number;
  }>;
  return { button, result: await fn() };
}

describe("google-meet create flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    googleMeetPluginTesting.setCallGatewayFromCliForTests();
  });

  it("CLI create prints the new meeting URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({
            access_token: "new-access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          name: "spaces/new-space",
          meetingCode: "new-abcd-xyz",
          meetingUri: "https://meet.google.com/new-abcd-xyz",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({
        oauth: { clientId: "client-id", refreshToken: "refresh-token" },
      }),
      ensureRuntime: async () => ({}) as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(["googlemeet", "create", "--no-join"], { from: "user" });
      expect(stdout.output()).toContain("meeting uri: https://meet.google.com/new-abcd-xyz");
      expect(stdout.output()).toContain("space: spaces/new-space");
    } finally {
      stdout.restore();
    }
  });

  it("can create a Meet through browser fallback without joining when requested", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          const proxy = params.params as { path?: string; body?: { url?: string } };
          if (proxy.path === "/tabs") {
            return { payload: { result: { tabs: [] } } };
          }
          if (proxy.path === "/tabs/open") {
            return {
              payload: {
                result: {
                  targetId: "tab-1",
                  title: "Meet",
                  url: proxy.body?.url,
                },
              },
            };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "tab-1",
                  result: {
                    meetingUri: "https://meet.google.com/browser-made-url",
                    browserUrl: "https://meet.google.com/browser-made-url",
                    browserTitle: "Meet",
                  },
                },
              },
            };
          }
          return { payload: { result: { ok: true } } };
        },
      },
    );
    const handler = methods.get("googlemeet.create") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { join: false }, respond });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      source: "browser",
      meetingUri: "https://meet.google.com/browser-made-url",
      joined: false,
      browser: { nodeId: "node-1", targetId: "tab-1" },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          path: "/tabs/open",
          body: { url: "https://meet.google.com/new" },
        }),
      }),
    );
  });

  it("reports structured manual action when browser creation needs Google login", async () => {
    const { methods } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          const proxy = params.params as { path?: string; body?: { url?: string } };
          if (proxy.path === "/tabs") {
            return { payload: { result: { tabs: [] } } };
          }
          if (proxy.path === "/tabs/open") {
            return {
              payload: {
                result: {
                  targetId: "login-tab",
                  title: "New Tab",
                  url: proxy.body?.url,
                },
              },
            };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "login-tab",
                  result: {
                    manualActionReason: "google-login-required",
                    manualAction:
                      "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
                    browserUrl: "https://accounts.google.com/signin",
                    browserTitle: "Sign in - Google Accounts",
                    notes: ["Sign-in page detected."],
                  },
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const handler = methods.get("googlemeet.create") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: {}, respond });

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      source: "browser",
      error:
        "google-login-required: Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
      manualActionRequired: true,
      manualActionReason: "google-login-required",
      manualActionMessage:
        "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
      browser: {
        nodeId: "node-1",
        targetId: "login-tab",
        browserUrl: "https://accounts.google.com/signin",
        browserTitle: "Sign in - Google Accounts",
        notes: ["Sign-in page detected."],
      },
    });
  });

  it("creates and joins a Meet through the create tool action by default", async () => {
    const { tools, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command === "googlemeet.chrome") {
            return { payload: { launched: true } };
          }
          const proxy = params.params as {
            path?: string;
            body?: { url?: string; targetId?: string; fn?: string };
          };
          if (proxy.path === "/tabs") {
            return { payload: { result: { tabs: [] } } };
          }
          if (proxy.path === "/tabs/open") {
            return {
              payload: {
                result: {
                  targetId:
                    proxy.body?.url === "https://meet.google.com/new" ? "create-tab" : "join-tab",
                  title: "Meet",
                  url: proxy.body?.url,
                },
              },
            };
          }
          if (proxy.path === "/act" && proxy.body?.fn?.includes("meetUrlPattern")) {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "create-tab",
                  result: {
                    meetingUri: "https://meet.google.com/new-abcd-xyz",
                    browserUrl: "https://meet.google.com/new-abcd-xyz",
                    browserTitle: "Meet",
                  },
                },
              },
            };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "join-tab",
                  result: JSON.stringify({
                    inCall: true,
                    micMuted: false,
                    title: "Meet call",
                    url: "https://meet.google.com/new-abcd-xyz",
                  }),
                },
              },
            };
          }
          return { payload: { result: { ok: true } } };
        },
      },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{
        details: { joined?: boolean; meetingUri?: string; join?: { session: { url: string } } };
      }>;
    };

    const result = await tool.execute("id", { action: "create" });

    expect(result.details).toMatchObject({
      source: "browser",
      joined: true,
      meetingUri: "https://meet.google.com/new-abcd-xyz",
      join: { session: { url: "https://meet.google.com/new-abcd-xyz" } },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          url: "https://meet.google.com/new-abcd-xyz",
          launch: false,
        }),
      }),
    );
  });

  it("returns structured manual action from the create tool action", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          const proxy = params.params as { path?: string; body?: { url?: string } };
          if (proxy.path === "/tabs") {
            return { payload: { result: { tabs: [] } } };
          }
          if (proxy.path === "/tabs/open") {
            return {
              payload: {
                result: {
                  targetId: "permission-tab",
                  title: "Meet",
                  url: proxy.body?.url,
                },
              },
            };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "permission-tab",
                  result: {
                    manualActionReason: "meet-permission-required",
                    manualAction:
                      "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
                    browserUrl: "https://meet.google.com/new",
                    browserTitle: "Meet",
                  },
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }>;
    };

    const result = await tool.execute("id", { action: "create" });

    expect(result.details).toMatchObject({
      source: "browser",
      manualActionRequired: true,
      manualActionReason: "meet-permission-required",
      manualActionMessage:
        "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
      browser: {
        nodeId: "node-1",
        targetId: "permission-tab",
        browserUrl: "https://meet.google.com/new",
        browserTitle: "Meet",
      },
    });
  });

  it("reuses an existing browser create tab instead of opening duplicates", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          const proxy = params.params as { path?: string; body?: { targetId?: string } };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  tabs: [
                    {
                      targetId: "existing-create-tab",
                      title: "Meet",
                      url: "https://meet.google.com/new",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: proxy.body?.targetId ?? "existing-create-tab",
                  result: {
                    meetingUri: "https://meet.google.com/reu-sedx-tab",
                    browserUrl: "https://meet.google.com/reu-sedx-tab",
                    browserTitle: "Meet",
                  },
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const handler = methods.get("googlemeet.create") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { join: false }, respond });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      source: "browser",
      meetingUri: "https://meet.google.com/reu-sedx-tab",
      browser: { nodeId: "node-1", targetId: "existing-create-tab" },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          path: "/tabs/focus",
          body: { targetId: "existing-create-tab" },
        }),
      }),
    );
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ path: "/tabs/open" }),
      }),
    );
  });

  it.each([
    ["Use microphone", "Accepted Meet microphone prompt with browser automation."],
    [
      "Continue without microphone",
      "Continued through Meet microphone prompt with browser automation.",
    ],
  ])(
    "uses browser automation for Meet's %s choice during browser creation",
    async (buttonText, note) => {
      const { button, result } = await runCreateMeetBrowserScript({ buttonText });

      expect(result).toMatchObject({
        retryAfterMs: 1000,
        notes: [note],
      });
      expect(button.click).toHaveBeenCalledTimes(1);
      expect(result.meetingUri).toBeUndefined();
      expect(result.manualActionReason).toBeUndefined();
    },
  );
});
