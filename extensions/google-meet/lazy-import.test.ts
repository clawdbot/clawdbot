import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { TranscriptSourceProvider } from "openclaw/plugin-sdk/transcripts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleMeetConfig } from "./src/config.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./src/transports/google-meet-platform-constants.js";

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type CliRegistrar = Parameters<OpenClawPluginApi["registerCli"]>[0];
type ToolFactory = Parameters<OpenClawPluginApi["registerTool"]>[0];

describe("google-meet lazy imports", () => {
  afterEach(() => {
    for (const moduleId of [
      "./src/plugin-helpers.js",
      "./src/runtime.js",
      "./src/node-host.js",
      "./src/node-invoke-policy.js",
      "./src/cli.js",
      "openclaw/plugin-sdk/gateway-runtime",
      "openclaw/plugin-sdk/param-readers",
      "openclaw/plugin-sdk/routing",
      "openclaw/plugin-sdk/transcripts",
    ]) {
      vi.doUnmock(moduleId);
    }
    vi.resetModules();
  });

  it("loads each runtime owner only on first use", async () => {
    let helperImports = 0;
    let runtimeImports = 0;
    let nodeHostImports = 0;
    let nodePolicyImports = 0;
    let cliImports = 0;
    let gatewayRuntimeImports = 0;
    let paramReaderImports = 0;
    let routingImports = 0;
    let transcriptSdkImports = 0;

    vi.doMock("./src/plugin-helpers.js", () => {
      helperImports += 1;
      return {
        createMeetFromParams: async () => ({ meetingUri: "https://meet.google.com/abc-defg-hij" }),
      };
    });
    vi.doMock("./src/runtime.js", () => {
      runtimeImports += 1;
      return {
        GoogleMeetRuntime: class {
          async status() {
            return { sessions: [] };
          }

          async testListen() {
            return { ok: true };
          }

          transcriptSourceRuntime() {
            return {
              startTranscriptSource: async () => ({ ok: true }),
              stopTranscriptSource: async () => ({ ok: true }),
            };
          }
        },
      };
    });
    vi.doMock("./src/node-host.js", () => {
      nodeHostImports += 1;
      return {
        handleGoogleMeetNodeHostCommand: async () => JSON.stringify({ ok: true }),
      };
    });
    vi.doMock("./src/node-invoke-policy.js", () => {
      nodePolicyImports += 1;
      return {
        createGoogleMeetChromeNodeInvokePolicy: () => ({
          commands: ["google-meet.chrome"],
          dangerous: true,
          handle: async () => ({ ok: true }),
        }),
      };
    });
    vi.doMock("./src/cli.js", () => {
      cliImports += 1;
      return {
        registerGoogleMeetCli: () => {},
      };
    });
    vi.doMock("openclaw/plugin-sdk/gateway-runtime", () => {
      gatewayRuntimeImports += 1;
      return {
        callGatewayFromCli: async () => ({ ok: true }),
      };
    });
    vi.doMock("openclaw/plugin-sdk/param-readers", () => {
      paramReaderImports += 1;
      return {
        readPositiveIntegerParam: () => 2_500,
      };
    });
    vi.doMock("openclaw/plugin-sdk/routing", () => {
      routingImports += 1;
      return {
        normalizeAgentId: (value: string) => value,
        parseAgentSessionKey: () => ({ agentId: "main" }),
      };
    });
    vi.doMock("openclaw/plugin-sdk/transcripts", () => {
      transcriptSdkImports += 1;
      return {};
    });

    const { default: googleMeetPlugin } = await import("./index.js");
    const gatewayMethods = new Map<string, GatewayHandler>();
    const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
    const nodePolicies: OpenClawPluginNodeInvokePolicy[] = [];
    const cliRegistrars: CliRegistrar[] = [];
    const transcriptProviders: TranscriptSourceProvider[] = [];
    let toolFactory: ToolFactory | undefined;
    googleMeetPlugin.register(
      createTestPluginApi({
        id: "google-meet",
        name: "Google Meet",
        source: "test",
        config: {},
        runtime: createPluginRuntimeMock(),
        registerGatewayMethod: (method, handler) => gatewayMethods.set(method, handler),
        registerNodeHostCommand: (command) => nodeCommands.push(command),
        registerNodeInvokePolicy: (policy) => nodePolicies.push(policy),
        registerCli: (registrar) => cliRegistrars.push(registrar),
        registerTool: (factory) => {
          toolFactory = factory;
        },
        registerTranscriptSourceProvider: (provider) => transcriptProviders.push(provider),
      }),
    );

    expect({
      helperImports,
      runtimeImports,
      nodeHostImports,
      nodePolicyImports,
      cliImports,
      gatewayRuntimeImports,
      paramReaderImports,
      routingImports,
      transcriptSdkImports,
    }).toEqual({
      helperImports: 0,
      runtimeImports: 0,
      nodeHostImports: 0,
      nodePolicyImports: 0,
      cliImports: 0,
      gatewayRuntimeImports: 0,
      paramReaderImports: 0,
      routingImports: 0,
      transcriptSdkImports: 0,
    });

    const createHandler = gatewayMethods.get("googlemeet.create");
    const statusHandler = gatewayMethods.get("googlemeet.status");
    const transcriptHandler = gatewayMethods.get("googlemeet.transcript");
    const testListenHandler = gatewayMethods.get("googlemeet.testListen");
    const respond = vi.fn();
    await transcriptHandler?.({ params: {}, respond } as never);
    await transcriptHandler?.({ params: {}, respond } as never);
    expect(gatewayRuntimeImports).toBe(0);

    await createHandler?.({ params: { join: false }, respond } as never);
    await createHandler?.({ params: { join: false }, respond } as never);
    await statusHandler?.({ params: {}, respond } as never);
    await statusHandler?.({ params: {}, respond } as never);
    await testListenHandler?.({ params: { timeoutMs: 2_500 }, respond } as never);
    await testListenHandler?.({ params: { timeoutMs: 2_500 }, respond } as never);
    const transcriptProvider = transcriptProviders[0];
    if (
      typeof transcriptProvider?.start !== "function" ||
      typeof transcriptProvider.stop !== "function"
    ) {
      throw new Error("expected Google Meet transcript provider");
    }
    await transcriptProvider.start({} as never);
    await transcriptProvider.stop({} as never);

    if (typeof toolFactory !== "function") {
      throw new Error("expected Google Meet tool factory");
    }
    const registeredTool = toolFactory({ sessionKey: "agent:main:main" } as never);
    const tool = Array.isArray(registeredTool) ? registeredTool[0] : registeredTool;
    if (!tool) {
      throw new Error("expected Google Meet tool");
    }
    await tool.execute("tool-call", { action: "status" } as never);
    await tool.execute("tool-call", { action: "status" } as never);

    await nodeCommands[0]?.handle();
    await nodeCommands[0]?.handle();
    await nodePolicies[0]?.handle({} as never);
    await nodePolicies[0]?.handle({} as never);
    await cliRegistrars[0]?.({ program: {} } as never);
    await cliRegistrars[0]?.({ program: {} } as never);

    expect({
      helperImports,
      runtimeImports,
      nodeHostImports,
      nodePolicyImports,
      cliImports,
      gatewayRuntimeImports,
      paramReaderImports,
      routingImports,
      transcriptSdkImports,
    }).toEqual({
      helperImports: 1,
      runtimeImports: 1,
      nodeHostImports: 1,
      nodePolicyImports: 1,
      cliImports: 1,
      gatewayRuntimeImports: 1,
      paramReaderImports: 1,
      routingImports: 1,
      transcriptSdkImports: 0,
    });
  });

  it("loads and caches the node policy delegate", async () => {
    const delegateHandle = vi.fn<OpenClawPluginNodeInvokePolicy["handle"]>(async () => ({
      ok: true,
    }));
    const loadPolicy = vi.fn(
      async (_config: GoogleMeetConfig): Promise<OpenClawPluginNodeInvokePolicy> => ({
        commands: [GOOGLE_MEET_NODE_COMMAND],
        dangerous: true,
        handle: delegateHandle,
      }),
    );
    const { createLazyGoogleMeetNodeInvokePolicy } = await import("./src/plugin-registration.js");
    const policy = createLazyGoogleMeetNodeInvokePolicy({} as GoogleMeetConfig, loadPolicy);

    expect(policy.commands).toEqual([GOOGLE_MEET_NODE_COMMAND]);
    expect(policy.dangerous).toBe(true);
    expect(loadPolicy).not.toHaveBeenCalled();

    await expect(policy.handle({} as OpenClawPluginNodeInvokePolicyContext)).resolves.toEqual({
      ok: true,
    });
    await expect(policy.handle({} as OpenClawPluginNodeInvokePolicyContext)).resolves.toEqual({
      ok: true,
    });
    expect(loadPolicy).toHaveBeenCalledTimes(1);
    expect(delegateHandle).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the node policy cannot load", async () => {
    const { createLazyGoogleMeetNodeInvokePolicy } = await import("./src/plugin-registration.js");
    const policy = createLazyGoogleMeetNodeInvokePolicy({} as GoogleMeetConfig, async () => {
      throw new Error("load failed");
    });

    await expect(policy.handle({} as OpenClawPluginNodeInvokePolicyContext)).resolves.toMatchObject(
      {
        ok: false,
        code: "PLUGIN_POLICY_UNAVAILABLE",
        unavailable: true,
      },
    );
  });

  it("does not rewrite node policy delegate failures", async () => {
    const delegateError = new Error("delegate failed");
    const { createLazyGoogleMeetNodeInvokePolicy } = await import("./src/plugin-registration.js");
    const policy = createLazyGoogleMeetNodeInvokePolicy(
      {} as GoogleMeetConfig,
      async () =>
        ({
          commands: [GOOGLE_MEET_NODE_COMMAND],
          dangerous: true,
          handle: async () => {
            throw delegateError;
          },
        }) satisfies OpenClawPluginNodeInvokePolicy,
    );

    await expect(policy.handle({} as OpenClawPluginNodeInvokePolicyContext)).rejects.toBe(
      delegateError,
    );
  });
});
