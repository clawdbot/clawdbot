import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import plugin from "./index.js";
import { resolveGoogleMeetConfig, resolveGoogleMeetConfigWithEnv } from "./src/config.js";
import {
  buildGoogleMeetPreflightReport,
  fetchGoogleMeetSpace,
  normalizeGoogleMeetSpaceName,
} from "./src/meet.js";
import {
  buildGoogleMeetAuthUrl,
  refreshGoogleMeetAccessToken,
  resolveGoogleMeetAccessToken,
} from "./src/oauth.js";
import { startNodeRealtimeAudioBridge } from "./src/realtime-node.js";
import { startCommandRealtimeAudioBridge } from "./src/realtime.js";
import { normalizeMeetUrl } from "./src/runtime.js";
import { buildMeetDtmfSequence, normalizeDialInNumber } from "./src/transports/twilio.js";

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

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type TestBridgeProcess = {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  on: EventEmitter["on"];
};

type NodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    connected?: boolean;
    commands?: string[];
    remoteIp?: string;
  }>;
};

function setup(
  config: Record<string, unknown> = {},
  options: {
    nodesListResult?: NodeListResult;
    nodesInvokeResult?: unknown;
    nodesInvokeHandler?: (params: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
    }) => Promise<unknown>;
  } = {},
) {
  const methods = new Map<string, unknown>();
  const tools: unknown[] = [];
  const cliRegistrations: unknown[] = [];
  const nodeHostCommands: unknown[] = [];
  const nodesList = vi.fn(
    async () =>
      options.nodesListResult ?? {
        nodes: [
          {
            nodeId: "node-1",
            displayName: "parallels-macos",
            connected: true,
            commands: ["googlemeet.chrome"],
          },
        ],
      },
  );
  const nodesInvoke = vi.fn(async (params) =>
    options.nodesInvokeHandler
      ? options.nodesInvokeHandler(params)
      : (options.nodesInvokeResult ?? { launched: true }),
  );
  const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
    if (argv[0] === "/usr/sbin/system_profiler") {
      return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const api = createTestPluginApi({
    id: "google-meet",
    name: "Google Meet",
    description: "test",
    version: "0",
    source: "test",
    pluginConfig: config,
    runtime: {
      system: {
        runCommandWithTimeout,
        formatNativeDependencyHint: vi.fn(() => "Install with brew install blackhole-2ch."),
      },
      nodes: {
        list: nodesList,
        invoke: nodesInvoke,
      },
    } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
    registerTool: (tool: unknown) => tools.push(tool),
    registerCli: (_registrar: unknown, opts: unknown) => cliRegistrations.push(opts),
    registerNodeHostCommand: (command: unknown) => nodeHostCommands.push(command),
  });
  plugin.register(api);
  return {
    cliRegistrations,
    methods,
    tools,
    runCommandWithTimeout,
    nodesList,
    nodesInvoke,
    nodeHostCommands,
  };
}

describe("google-meet plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to chrome realtime with safe read-only tools", () => {
    expect(resolveGoogleMeetConfig({})).toMatchObject({
      enabled: true,
      defaults: {},
      preview: { enrollmentAcknowledged: false },
      defaultTransport: "chrome",
      defaultMode: "realtime",
      chrome: {
        audioBackend: "blackhole-2ch",
        launch: true,
        audioInputCommand: [
          "rec",
          "-q",
          "-t",
          "raw",
          "-r",
          "8000",
          "-c",
          "1",
          "-e",
          "mu-law",
          "-b",
          "8",
          "-",
        ],
        audioOutputCommand: [
          "play",
          "-q",
          "-t",
          "raw",
          "-r",
          "8000",
          "-c",
          "1",
          "-e",
          "mu-law",
          "-b",
          "8",
          "-",
        ],
      },
      voiceCall: { enabled: true, requestTimeoutMs: 30000, dtmfDelayMs: 2500 },
      realtime: {
        provider: "openai",
        introMessage: "Say exactly: I'm here and listening.",
        toolPolicy: "safe-read-only",
      },
      oauth: {},
      auth: { provider: "google-oauth" },
    });
    expect(resolveGoogleMeetConfig({}).realtime.instructions).toContain("openclaw_agent_consult");
  });

  it("uses env fallbacks for OAuth, preview, and default meeting values", () => {
    expect(
      resolveGoogleMeetConfigWithEnv(
        {},
        {
          OPENCLAW_GOOGLE_MEET_CLIENT_ID: "client-id",
          GOOGLE_MEET_CLIENT_SECRET: "client-secret",
          OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN: "refresh-token",
          GOOGLE_MEET_ACCESS_TOKEN: "access-token",
          OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: "123456",
          GOOGLE_MEET_DEFAULT_MEETING: "https://meet.google.com/abc-defg-hij",
          OPENCLAW_GOOGLE_MEET_PREVIEW_ACK: "true",
        },
      ),
    ).toMatchObject({
      defaults: { meeting: "https://meet.google.com/abc-defg-hij" },
      preview: { enrollmentAcknowledged: true },
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        accessToken: "access-token",
        expiresAt: 123456,
      },
    });
  });

  it("requires explicit Meet URLs", () => {
    expect(normalizeMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(() => normalizeMeetUrl("https://example.com/abc-defg-hij")).toThrow("meet.google.com");
  });

  it("advertises only the googlemeet CLI descriptor", () => {
    const { cliRegistrations } = setup();

    expect(cliRegistrations).toContainEqual({
      commands: ["googlemeet"],
      descriptors: [
        {
          name: "googlemeet",
          description: "Join and manage Google Meet calls",
          hasSubcommands: true,
        },
      ],
    });
  });

  it("registers the node-host command used by chrome-node transport", () => {
    const { nodeHostCommands } = setup();

    expect(nodeHostCommands).toContainEqual(
      expect.objectContaining({
        command: "googlemeet.chrome",
        cap: "google-meet",
        handle: expect.any(Function),
      }),
    );
  });

  it("uses a provider-safe flat tool parameter schema", () => {
    const { tools } = setup();
    const tool = tools[0] as { parameters: unknown };

    expect(JSON.stringify(tool.parameters)).not.toContain("anyOf");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["join", "status", "setup_status", "resolve_space", "preflight", "leave", "speak"],
        },
        transport: { type: "string", enum: ["chrome", "chrome-node", "twilio"] },
        mode: { type: "string", enum: ["realtime", "transcribe"] },
      },
    });
  });

  it("normalizes Meet URLs, codes, and space names for the Meet API", () => {
    expect(normalizeGoogleMeetSpaceName("spaces/abc-defg-hij")).toBe("spaces/abc-defg-hij");
    expect(normalizeGoogleMeetSpaceName("abc-defg-hij")).toBe("spaces/abc-defg-hij");
    expect(normalizeGoogleMeetSpaceName("https://meet.google.com/abc-defg-hij")).toBe(
      "spaces/abc-defg-hij",
    );
    expect(() => normalizeGoogleMeetSpaceName("https://example.com/abc-defg-hij")).toThrow(
      "meet.google.com",
    );
  });

  it("fetches Meet spaces without percent-encoding the spaces path separator", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          name: "spaces/abc-defg-hij",
          meetingCode: "abc-defg-hij",
          meetingUri: "https://meet.google.com/abc-defg-hij",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchGoogleMeetSpace({
        accessToken: "token",
        meeting: "spaces/abc-defg-hij",
      }),
    ).resolves.toMatchObject({ name: "spaces/abc-defg-hij" });
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
        init: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
        }),
        policy: { allowedHostnames: ["meet.googleapis.com"] },
        auditContext: "google-meet.spaces.get",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("surfaces Developer Preview acknowledgment blockers in preflight reports", () => {
    expect(
      buildGoogleMeetPreflightReport({
        input: "abc-defg-hij",
        space: { name: "spaces/abc-defg-hij" },
        previewAcknowledged: false,
        tokenSource: "cached-access-token",
      }),
    ).toMatchObject({
      resolvedSpaceName: "spaces/abc-defg-hij",
      previewAcknowledged: false,
      blockers: [expect.stringContaining("Developer Preview Program")],
    });
  });

  it("builds Meet OAuth URLs and prefers fresh cached access tokens", async () => {
    const url = new URL(
      buildGoogleMeetAuthUrl({
        clientId: "client-id",
        challenge: "challenge",
        state: "state",
      }),
    );
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("meetings.conference.media.readonly");

    await expect(
      resolveGoogleMeetAccessToken({
        accessToken: "cached-token",
        expiresAt: Date.now() + 120_000,
      }),
    ).resolves.toEqual({
      accessToken: "cached-token",
      expiresAt: expect.any(Number),
      refreshed: false,
    });
  });

  it("refreshes Google Meet access tokens with a refresh-token grant", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshGoogleMeetAccessToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      }),
    ).resolves.toMatchObject({
      accessToken: "new-access-token",
      tokenType: "Bearer",
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-token");
  });

  it("builds Twilio dial plans from a PIN", () => {
    expect(normalizeDialInNumber("+1 (555) 123-4567")).toBe("+15551234567");
    expect(buildMeetDtmfSequence({ pin: "123 456" })).toBe("123456#");
    expect(buildMeetDtmfSequence({ dtmfSequence: "ww123#" })).toBe("ww123#");
  });

  it("joins a Twilio session through the tool without page parsing", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { session: unknown } }>;
    };
    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    expect(result.details.session).toMatchObject({
      transport: "twilio",
      mode: "realtime",
      twilio: {
        dialInNumber: "+15551234567",
        pinProvided: true,
        dtmfSequence: "123456#",
        voiceCallId: "call-1",
        dtmfSent: true,
      },
    });
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith({
      config: expect.objectContaining({ defaultTransport: "twilio" }),
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
    });
  });

  it("hangs up delegated Twilio calls on leave", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { session: { id: string } } }>;
    };
    const joined = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    await tool.execute("id", { action: "leave", sessionId: joined.details.session.id });

    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).toHaveBeenCalledWith({
      config: expect.objectContaining({ defaultTransport: "twilio" }),
      callId: "call-1",
    });
  });

  it("reports setup status through the tool", async () => {
    const { tools } = setup({
      chrome: {
        audioInputCommand: ["openclaw-audio-bridge", "capture"],
        audioOutputCommand: ["openclaw-audio-bridge", "play"],
      },
    });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { ok?: boolean } }>;
    };

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(true);
  });

  it("launches Chrome after the BlackHole check", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { methods, runCommandWithTimeout } = setup({
        defaultMode: "transcribe",
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
        1,
        ["/usr/sbin/system_profiler", "SPAudioDataType"],
        { timeoutMs: 10000 },
      );
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
        2,
        ["open", "-a", "Google Chrome", "https://meet.google.com/abc-defg-hij"],
        { timeoutMs: 30000 },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("joins Chrome on a paired node without local Chrome or BlackHole", async () => {
    const { methods, nodesList, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeResult: { payload: { launched: true } },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond,
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(nodesList).toHaveBeenCalledWith({ connected: true });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          url: "https://meet.google.com/abc-defg-hij",
          mode: "transcribe",
        }),
      }),
    );
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      session: {
        transport: "chrome-node",
        chrome: {
          nodeId: "node-1",
          launched: true,
        },
      },
    });
  });

  it("explains when chrome-node has no capable paired node", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesListResult: { nodes: [] },
      },
    );
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { error?: string } }>;
    };

    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.error).toContain("No connected Google Meet-capable node");
    expect(result.details.error).toContain("openclaw node run");
  });

  it("requires chromeNode.node when multiple capable nodes are connected", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesListResult: {
          nodes: [
            {
              nodeId: "node-1",
              displayName: "parallels-macos",
              connected: true,
              commands: ["googlemeet.chrome"],
            },
            {
              nodeId: "node-2",
              displayName: "mac-studio-vm",
              connected: true,
              commands: ["googlemeet.chrome"],
            },
          ],
        },
      },
    );
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { error?: string } }>;
    };

    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.error).toContain("Multiple Google Meet-capable nodes connected");
    expect(result.details.error).toContain("chromeNode.node");
  });

  it("runs configured Chrome audio bridge commands before launch", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { methods, runCommandWithTimeout } = setup({
        chrome: {
          audioBridgeHealthCommand: ["bridge", "status"],
          audioBridgeCommand: ["bridge", "start"],
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(2, ["bridge", "status"], {
        timeoutMs: 30000,
      });
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(3, ["bridge", "start"], {
        timeoutMs: 30000,
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("pipes Chrome command-pair audio through the realtime provider", async () => {
    let callbacks:
      | {
          onAudio: (audio: Buffer) => void;
          onMark?: (markName: string) => void;
          onToolCall?: (event: {
            itemId: string;
            callId: string;
            name: string;
            args: unknown;
          }) => void;
          onReady?: () => void;
          tools?: unknown[];
        }
      | undefined;
    const sendAudio = vi.fn();
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: (req) => {
        callbacks = req;
        return bridge;
      },
    };
    const inputStdout = new PassThrough();
    const outputStdinWrites: Buffer[] = [];
    const makeProcess = (stdio: {
      stdin?: { write(chunk: unknown): unknown } | null;
      stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
    }): TestBridgeProcess => {
      const proc = new EventEmitter() as unknown as TestBridgeProcess;
      proc.stdin = stdio.stdin;
      proc.stdout = stdio.stdout;
      proc.stderr = new PassThrough();
      proc.killed = false;
      proc.kill = vi.fn(() => {
        proc.killed = true;
        return true;
      });
      return proc;
    };
    const outputStdin = new Writable({
      write(chunk, _encoding, done) {
        outputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const inputProcess = makeProcess({ stdout: inputStdout, stdin: null });
    const outputProcess = makeProcess({ stdin: outputStdin, stdout: null });
    const spawnMock = vi.fn().mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const sessionStore: Record<string, unknown> = {};
    const runtime = {
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => sessionStore),
          saveSessionStore: vi.fn(async () => {}),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the Portugal launch data." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startCommandRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    inputStdout.write(Buffer.from([1, 2, 3]));
    callbacks?.onAudio(Buffer.from([4, 5]));
    callbacks?.onMark?.("mark-1");
    callbacks?.onReady?.();
    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: "openclaw_agent_consult",
      args: { question: "What should I say about launch timing?" },
    });

    expect(spawnMock).toHaveBeenNthCalledWith(1, "play-meet", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, "capture-meet", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(outputStdinWrites).toEqual([Buffer.from([4, 5])]);
    expect(bridge.acknowledgeMark).toHaveBeenCalled();
    expect(bridge.triggerGreeting).toHaveBeenCalledWith("Say exactly: I'm here and listening.");
    handle.speak("Say exactly: hello from the meeting.");
    expect(bridge.triggerGreeting).toHaveBeenLastCalledWith("Say exactly: hello from the meeting.");
    expect(callbacks).toMatchObject({
      tools: [
        expect.objectContaining({
          name: "openclaw_agent_consult",
        }),
      ],
    });
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenCalledWith("tool-call-1", {
        text: "Use the Portugal launch data.",
      });
    });
    expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageProvider: "google-meet",
        thinkLevel: "high",
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
      }),
    );

    await handle.stop();
    expect(bridge.close).toHaveBeenCalled();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("pipes paired-node command-pair audio through the realtime provider", async () => {
    let callbacks:
      | {
          onAudio: (audio: Buffer) => void;
          onToolCall?: (event: {
            itemId: string;
            callId: string;
            name: string;
            args: unknown;
          }) => void;
          onReady?: () => void;
          tools?: unknown[];
        }
      | undefined;
    const sendAudio = vi.fn();
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: (req) => {
        callbacks = req;
        return bridge;
      },
    };
    let pullCount = 0;
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string; base64?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            if (pullCount === 1) {
              return { bridgeId: "bridge-1", base64: Buffer.from([9, 8, 7]).toString("base64") };
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            return { bridgeId: "bridge-1" };
          }
          return { ok: true };
        }),
      },
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => ({})),
          saveSessionStore: vi.fn(async () => {}),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the launch update." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startNodeRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      nodeId: "node-1",
      bridgeId: "bridge-1",
      logger: noopLogger,
      providers: [provider],
    });

    callbacks?.onAudio(Buffer.from([1, 2, 3]));
    callbacks?.onReady?.();
    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: "openclaw_agent_consult",
      args: { question: "What should I say?" },
    });

    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9, 8, 7]));
    });
    await vi.waitFor(() => {
      expect(runtime.nodes.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: expect.objectContaining({
            action: "pushAudio",
            bridgeId: "bridge-1",
            base64: Buffer.from([1, 2, 3]).toString("base64"),
          }),
        }),
      );
    });
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenCalledWith("tool-call-1", {
        text: "Use the launch update.",
      });
    });
    expect(bridge.triggerGreeting).toHaveBeenCalledWith("Say exactly: I'm here and listening.");
    handle.speak("Say exactly: hello from the node.");
    expect(bridge.triggerGreeting).toHaveBeenLastCalledWith("Say exactly: hello from the node.");
    expect(callbacks).toMatchObject({
      tools: [
        expect.objectContaining({
          name: "openclaw_agent_consult",
        }),
      ],
    });
    expect(handle).toMatchObject({
      type: "node-command-pair",
      providerId: "openai",
      nodeId: "node-1",
      bridgeId: "bridge-1",
    });

    await handle.stop();

    expect(bridge.close).toHaveBeenCalled();
    expect(runtime.nodes.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: { action: "stop", bridgeId: "bridge-1" },
        timeoutMs: 5_000,
      }),
    );
  });
});
