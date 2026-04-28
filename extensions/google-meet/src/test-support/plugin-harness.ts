import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { vi } from "vitest";

type GoogleMeetTestPluginEntry = {
  register(api: OpenClawPluginApi): void;
};

export const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

export type GoogleMeetTestNodeListResult = {
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
              url: proxy.body?.url ?? "https://meet.google.com/abc-defg-hij",
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
                  url: "https://meet.google.com/abc-defg-hij",
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
  const api = createTestPluginApi({
    id: "google-meet",
    name: "Google Meet",
    description: "test",
    version: "0",
    source: "test",
    config: options.fullConfig ?? {},
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

export async function invokeGoogleMeetGatewayMethodForTest(
  methods: Map<string, unknown>,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const handler = methods.get(method) as
    | ((opts: {
        params: Record<string, unknown>;
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
        respond,
      }),
    ).catch(reject);
  });
}
