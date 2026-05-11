import { Command } from "commander";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({
    callId: "call-1",
    dtmfSent: true,
    introSent: true,
  })),
  endMeetVoiceCallGatewayCall: vi.fn(async () => {}),
  speakMeetViaVoiceCallGateway: vi.fn(async () => {}),
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

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
  };
});

vi.mock("./src/voice-call-gateway.js", () => ({
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
  endMeetVoiceCallGatewayCall: voiceCallMocks.endMeetVoiceCallGatewayCall,
  speakMeetViaVoiceCallGateway: voiceCallMocks.speakMeetViaVoiceCallGateway,
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
  googleMeetPluginTesting.setPlatformForTests(() => options?.registerPlatform ?? "darwin");
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function mockCalls(mock: unknown, label: string): Array<Array<unknown>> {
  const mockState = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock;
  expect(mockState, `${label}.mock`).toBeDefined();
  expect(Array.isArray(mockState?.calls), `${label}.mock.calls`).toBe(true);
  return mockState?.calls ?? [];
}

function findMockCall(mock: unknown, label: string, predicate: (call: Array<unknown>) => boolean) {
  const call = mockCalls(mock, label).find(predicate);
  expect(call, label).toBeDefined();
  return call as Array<unknown>;
}

function responsePayload(respond: unknown): Record<string, unknown> {
  const calls = mockCalls(respond, "respond");
  expect(calls[0]?.[0]).toBe(true);
  return requireRecord(calls[0]?.[1], "response payload");
}

function responseErrorPayload(respond: unknown): Record<string, unknown> {
  const calls = mockCalls(respond, "respond");
  expect(calls[0]?.[0]).toBe(false);
  return requireRecord(calls[0]?.[1], "response payload");
}

function findNodeInvokeParams(
  nodesInvoke: unknown,
  label: string,
  predicate: (params: Record<string, unknown>) => boolean,
) {
  const call = findMockCall(nodesInvoke, label, ([value]) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    return predicate(value as Record<string, unknown>);
  });
  return requireRecord(call[0], label);
}

describe("google-meet create flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    googleMeetPluginTesting.setCallGatewayFromCliForTests();
    googleMeetPluginTesting.setPlatformForTests();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.doUnmock("./src/voice-call-gateway.js");
    vi.resetModules();
  });

  it("CLI create can configure API-created space access", async () => {
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
      await program.parseAsync(
        [
          "googlemeet",
          "create",
          "--no-join",
          "--access-type",
          "OPEN",
          "--entry-point-access",
          "ALL",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain("meeting uri: https://meet.google.com/new-abcd-xyz");
      expect(stdout.output()).toContain("space: spaces/new-space");
      const createSpaceCall = findMockCall(
        fetchMock,
        "create space fetch",
        ([url]) => url === "https://meet.googleapis.com/v2/spaces",
      );
      const createSpaceInit = requireRecord(createSpaceCall[1], "create space init");
      expect(createSpaceInit.method).toBe("POST");
      expect(createSpaceInit.body).toBe(
        JSON.stringify({ config: { accessType: "OPEN", entryPointAccess: "ALL" } }),
      );
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

    const payload = responsePayload(respond);
    expect(payload.source).toBe("browser");
    expect(payload.meetingUri).toBe("https://meet.google.com/browser-made-url");
    expect(payload.joined).toBe(false);
    const browser = requireRecord(payload.browser, "browser payload");
    expect(browser.nodeId).toBe("node-1");
    expect(browser.targetId).toBe("tab-1");
    findNodeInvokeParams(nodesInvoke, "open create tab", (params) => {
      if (params.command !== "browser.proxy") {
        return false;
      }
      if (!params.params || typeof params.params !== "object") {
        return false;
      }
      const proxy = params.params as Record<string, unknown>;
      if (!proxy.body || typeof proxy.body !== "object") {
        return false;
      }
      const body = proxy.body as Record<string, unknown>;
      return proxy.path === "/tabs/open" && body.url === "https://meet.google.com/new";
    });
  });

  it("rejects access policy flags when tool create would use browser fallback", async () => {
    const { methods } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async () => {
          throw new Error("browser fallback should not run");
        },
      },
    );

    await expect(
      invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.create", {
        join: false,
        accessType: "OPEN",
      }),
    ).rejects.toThrow("access policy options require OAuth/API room creation");
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

    const payload = responseErrorPayload(respond);
    expect(payload.source).toBe("browser");
    expect(payload.error).toBe(
      "google-login-required: Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
    );
    expect(payload.manualActionRequired).toBe(true);
    expect(payload.manualActionReason).toBe("google-login-required");
    expect(payload.manualActionMessage).toBe(
      "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
    );
    const browser = requireRecord(payload.browser, "browser payload");
    expect(browser.nodeId).toBe("node-1");
    expect(browser.targetId).toBe("login-tab");
    expect(browser.browserUrl).toBe("https://accounts.google.com/signin");
    expect(browser.browserTitle).toBe("Sign in - Google Accounts");
    expect(browser.notes).toEqual(["Sign-in page detected."]);
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
        details: {
          source?: string;
          joined?: boolean;
          meetingUri?: string;
          join?: { session: { url: string } };
        };
      }>;
    };

    const result = await tool.execute("id", { action: "create" });

    expect(result.details.source).toBe("browser");
    expect(result.details.joined).toBe(true);
    expect(result.details.meetingUri).toBe("https://meet.google.com/new-abcd-xyz");
    expect(result.details.join?.session.url).toBe("https://meet.google.com/new-abcd-xyz");
    findNodeInvokeParams(nodesInvoke, "googlemeet chrome start", (params) => {
      if (params.command !== "googlemeet.chrome") {
        return false;
      }
      const chromeParams = requireRecord(params.params, "chrome params");
      return (
        chromeParams.action === "start" &&
        chromeParams.url === "https://meet.google.com/new-abcd-xyz" &&
        chromeParams.launch === false
      );
    });
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

    expect(result.details.source).toBe("browser");
    expect(result.details.manualActionRequired).toBe(true);
    expect(result.details.manualActionReason).toBe("meet-permission-required");
    expect(result.details.manualActionMessage).toBe(
      "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
    );
    const browser = requireRecord(result.details.browser, "browser details");
    expect(browser.nodeId).toBe("node-1");
    expect(browser.targetId).toBe("permission-tab");
    expect(browser.browserUrl).toBe("https://meet.google.com/new");
    expect(browser.browserTitle).toBe("Meet");
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

    const payload = responsePayload(respond);
    expect(payload.source).toBe("browser");
    expect(payload.meetingUri).toBe("https://meet.google.com/reu-sedx-tab");
    const browser = requireRecord(payload.browser, "browser payload");
    expect(browser.nodeId).toBe("node-1");
    expect(browser.targetId).toBe("existing-create-tab");
    findNodeInvokeParams(nodesInvoke, "focus existing tab", (params) => {
      if (!params.params || typeof params.params !== "object") {
        return false;
      }
      const proxy = params.params as Record<string, unknown>;
      if (!proxy.body || typeof proxy.body !== "object") {
        return false;
      }
      const body = proxy.body as Record<string, unknown>;
      return proxy.path === "/tabs/focus" && body.targetId === "existing-create-tab";
    });
    const openedCreateTab = mockCalls(nodesInvoke, "nodes invoke").some(([value]) => {
      if (!value || typeof value !== "object") {
        return false;
      }
      const params = value as Record<string, unknown>;
      if (!params.params || typeof params.params !== "object") {
        return false;
      }
      const proxy = params.params as Record<string, unknown>;
      return proxy.path === "/tabs/open";
    });
    expect(openedCreateTab).toBe(false);
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

      expect(result.retryAfterMs).toBe(1000);
      expect(result.notes).toEqual([note]);
      expect(button.click).toHaveBeenCalledTimes(1);
      expect(result.meetingUri).toBeUndefined();
      expect(result.manualActionReason).toBeUndefined();
    },
  );
});
