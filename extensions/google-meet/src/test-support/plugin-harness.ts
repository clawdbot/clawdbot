// Google Meet plugin module implements plugin harness behavior.
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { AgentToolResult } from "openclaw/plugin-sdk/tool-results";
import { vi } from "vitest";
import type { GoogleMeetCalendarLookupResult } from "../calendar.js";
import { listGoogleMeetCalendarEvents } from "../calendar.js";
import type { GoogleMeetExportManifest } from "../cli-shared.js";
import type {
  GoogleMeetArtifactsResult,
  GoogleMeetAttendanceResult,
  GoogleMeetLatestConferenceRecordResult,
} from "../meet-api.js";
import type { GoogleMeetRuntime } from "../runtime.js";
import { MEET_URL } from "./fixtures.test-helpers.js";

type GoogleMeetTestPluginEntry = {
  register(api: OpenClawPluginApi): void;
};

export const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type GoogleMeetTestNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    connected?: boolean;
    commands?: string[];
    caps?: string[];
    remoteIp?: string;
  }>;
};

type CommandResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

export function setupGoogleMeetPlugin(
  plugin: GoogleMeetTestPluginEntry,
  config: Record<string, unknown> = {},
  options: {
    fullConfig?: Record<string, unknown>;
    gatewayAvailable?: boolean;
    gatewayRequestHandler?: (
      method: string,
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    nodesListResult?: GoogleMeetTestNodeListResult;
    nodesInvokeResult?: unknown;
    browserActResult?: Record<string, unknown>;
    nodesInvokeHandler?: (params: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
    }) => Promise<unknown>;
    runCommandWithTimeoutHandler?: (
      argv: string[],
      options?: { timeoutMs?: number },
    ) => Promise<CommandResult>;
    registerPlatform?: NodeJS.Platform;
    toolContext?: Record<string, unknown>;
  } = {},
) {
  const methods = new Map<string, unknown>();
  const tools: AnyAgentTool[] = [];
  const cliRegistrations: unknown[] = [];
  const nodeHostCommands: unknown[] = [];
  const nodeInvokePolicies: unknown[] = [];
  const nodesList = vi.fn(
    async () =>
      options.nodesListResult ?? {
        nodes: [
          {
            nodeId: "node-1",
            displayName: "parallels-macos",
            connected: true,
            caps: ["browser"],
            commands: ["browser.proxy", "googlemeet.chrome"],
          },
        ],
      },
  );
  const nodesInvoke = vi.fn(async (params) => {
    if (options.nodesInvokeHandler) {
      return options.nodesInvokeHandler(params);
    }
    if (params.command === "browser.proxy") {
      const proxy = params.params as { path?: string; body?: { url?: string; targetId?: string } };
      if (proxy.path === "/tabs") {
        return { payload: { result: { running: true, tabs: [] } } };
      }
      if (proxy.path === "/tabs/open") {
        return {
          payload: {
            result: {
              targetId: "tab-1",
              title: "Meet",
              url: proxy.body?.url ?? MEET_URL,
            },
          },
        };
      }
      if (proxy.path === "/act") {
        return {
          payload: {
            result: {
              ok: true,
              targetId: proxy.body?.targetId ?? "tab-1",
              result: JSON.stringify(
                options.browserActResult ?? {
                  inCall: true,
                  micMuted: false,
                  title: "Meet call",
                  url: MEET_URL,
                },
              ),
            },
          },
        };
      }
      return { payload: { result: { ok: true } } };
    }
    return options.nodesInvokeResult ?? { launched: true };
  });
  const runCommandWithTimeout = vi.fn(
    async (argv: string[], runOptions?: { timeoutMs?: number }) => {
      if (options.runCommandWithTimeoutHandler) {
        return options.runCommandWithTimeoutHandler(argv, runOptions);
      }
      if (argv[0] === "/usr/sbin/system_profiler") {
        return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  const gatewayRequest = vi.fn(
    async (
      method: string,
      params?: Record<string, unknown>,
      requestOptions?: Record<string, unknown>,
    ) =>
      options.gatewayRequestHandler
        ? await options.gatewayRequestHandler(method, params, requestOptions)
        : await invokeGoogleMeetGatewayMethodForTest(methods, method, params, "google-meet"),
  );
  const api = createTestPluginApi({
    id: "google-meet",
    name: "Google Meet",
    description: "test",
    version: "0",
    source: "test",
    config: options.fullConfig ?? {},
    pluginConfig: config,
    runtime: {
      gateway: {
        isAvailable: vi.fn(async () => options.gatewayAvailable === true),
        request: gatewayRequest,
      },
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
    registerTool: (tool) => {
      const registered = typeof tool === "function" ? tool(options.toolContext ?? {}) : tool;
      if (Array.isArray(registered)) {
        tools.push(...registered);
      } else if (registered) {
        tools.push(registered);
      }
    },
    registerCli: (_registrar: unknown, opts: unknown) => cliRegistrations.push(opts),
    registerNodeHostCommand: (command: unknown) => nodeHostCommands.push(command),
    registerNodeInvokePolicy: (policy: unknown) => nodeInvokePolicies.push(policy),
  });
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: options.registerPlatform ?? "darwin",
  });
  try {
    plugin.register(api);
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  }
  return {
    cliRegistrations,
    methods,
    tools,
    runCommandWithTimeout,
    nodesList,
    nodesInvoke,
    nodeHostCommands,
    nodeInvokePolicies,
    gatewayRequest,
  };
}

type GoogleMeetToolError = {
  error?: string;
  manualActionRequired?: boolean;
  manualActionReason?: string;
};

type GoogleMeetToolDetails = {
  join: Awaited<ReturnType<GoogleMeetRuntime["join"]>>;
  test_speech: Awaited<ReturnType<GoogleMeetRuntime["testSpeech"]>>;
  test_listen: Awaited<ReturnType<GoogleMeetRuntime["testListen"]>>;
  status: Awaited<ReturnType<GoogleMeetRuntime["status"]>>;
  transcript: Awaited<ReturnType<GoogleMeetRuntime["transcript"]>>;
  recover_current_tab: Awaited<ReturnType<GoogleMeetRuntime["recoverCurrentTab"]>>;
  setup_status: Awaited<ReturnType<GoogleMeetRuntime["setupStatus"]>>;
  latest: GoogleMeetLatestConferenceRecordResult & {
    calendarEvent?: GoogleMeetCalendarLookupResult;
  };
  calendar_events: Awaited<ReturnType<typeof listGoogleMeetCalendarEvents>>;
  artifacts: GoogleMeetArtifactsResult;
  attendance: GoogleMeetAttendanceResult;
  export: {
    dryRun?: boolean;
    files?: string[];
    manifest?: GoogleMeetExportManifest;
    zipFile?: string;
  };
  leave: Awaited<ReturnType<GoogleMeetRuntime["leave"]>>;
  speak: Awaited<ReturnType<GoogleMeetRuntime["speak"]>>;
};

type GoogleMeetTestTool = Omit<AnyAgentTool, "execute"> & {
  execute<Action extends keyof GoogleMeetToolDetails>(
    toolCallId: string,
    params: { action: Action } & Record<string, unknown>,
  ): Promise<AgentToolResult<GoogleMeetToolDetails[Action] & GoogleMeetToolError>>;
};

export function getMeetTool(harness: Pick<ReturnType<typeof setupGoogleMeetPlugin>, "tools">) {
  const tool = harness.tools[0];
  if (!tool) {
    throw new Error("Expected Google Meet tool registration");
  }
  return tool as GoogleMeetTestTool;
}

export async function invokeGoogleMeetGatewayMethodForTest(
  methods: Map<string, unknown>,
  method: string,
  params?: unknown,
  pluginRuntimeOwnerId?: string,
): Promise<unknown> {
  const handler = methods.get(method) as
    | ((opts: {
        params: Record<string, unknown>;
        client?: { internal?: { pluginRuntimeOwnerId?: string } };
        respond: (
          ok: boolean,
          payload?: unknown,
          error?: { message?: string; details?: unknown },
        ) => void;
      }) => Promise<void> | void)
    | undefined;
  if (!handler) {
    throw new Error(`gateway method not registered: ${method}`);
  }
  return await new Promise((resolve, reject) => {
    const respond = (
      ok: boolean,
      payload?: unknown,
      error?: { message?: string; details?: unknown },
    ) => {
      if (ok) {
        resolve(payload);
        return;
      }
      const err = new Error(error?.message ?? "gateway request failed") as Error & {
        details?: unknown;
      };
      err.details = error?.details ?? payload;
      reject(err);
    };
    void Promise.resolve(
      handler({
        params: (params && typeof params === "object" && !Array.isArray(params)
          ? params
          : {}) as Record<string, unknown>,
        ...(pluginRuntimeOwnerId ? { client: { internal: { pluginRuntimeOwnerId } } } : {}),
        respond,
      }),
    ).catch(reject);
  });
}
