// WhatsApp call tool tests cover requester binding, audio framing, and process cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWhatsAppCallTool } from "./agent-tools-call.js";

const runtimeContextMocks = vi.hoisted(() => ({
  controllers: new Map<string, unknown>(),
}));
const defaultDependencyMocks = vi.hoisted(() => ({
  binaryFound: true,
  oauthDir: "",
}));

vi.mock("openclaw/plugin-sdk/setup-tools", () => ({
  detectBinary: vi.fn(async () => defaultDependencyMocks.binaryFound),
}));

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveOAuthDir: () => defaultDependencyMocks.oauthDir,
}));

vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: (accountId: string) =>
    runtimeContextMocks.controllers.get(accountId) ?? null,
}));

function createApi(params?: {
  speech?: Partial<
    Awaited<ReturnType<OpenClawPluginApi["runtime"]["tts"]["textToSpeechTelephony"]>>
  >;
  runCommand?: OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];
}): OpenClawPluginApi {
  return {
    config: {},
    registerTool: vi.fn(),
    runtime: {
      tts: {
        textToSpeechTelephony: vi.fn(async () => ({
          success: true,
          audioBuffer: Buffer.alloc(48_000, 1),
          outputFormat: "pcm",
          sampleRate: 24_000,
          provider: "openai",
          ...params?.speech,
        })),
      },
      system: {
        runCommandWithTimeout:
          params?.runCommand ??
          vi.fn(async () => ({
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit" as const,
          })),
      },
    },
  } as unknown as OpenClawPluginApi;
}

function createContext(
  overrides: Partial<OpenClawPluginToolContext> = {},
): OpenClawPluginToolContext {
  return {
    config: { channels: { whatsapp: { actions: { calls: true } } } },
    messageChannel: "whatsapp",
    agentAccountId: "default",
    requesterSenderId: "+15551234567",
    ...overrides,
  };
}

function resolveRegisteredCallTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool | null {
  registerWhatsAppCallTool(api);
  const factory = vi.mocked(api.registerTool).mock.calls.at(-1)?.[0];
  if (typeof factory !== "function") {
    throw new Error("WhatsApp call tool factory was not registered");
  }
  return factory(context) as AnyAgentTool | null;
}

function quotePosixShellArgForExpected(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("WhatsApp call tool", () => {
  let rootDir: string;
  let stateDir: string;

  beforeEach(async () => {
    runtimeContextMocks.controllers.clear();
    defaultDependencyMocks.binaryFound = true;
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-call-test-"));
    defaultDependencyMocks.oauthDir = path.join(rootDir, "call dir", "$HOME's");
    stateDir = path.join(defaultDependencyMocks.oauthDir, "whatsapp-calls", "default");
    await fs.mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("is opt-in and available only for a trusted WhatsApp requester", () => {
    const api = createApi();

    expect(resolveRegisteredCallTool(api, createContext({ config: {} }))).toBeNull();
    expect(
      resolveRegisteredCallTool(
        api,
        createContext({
          config: { channels: { whatsapp: { actions: { calls: false } } } },
        }),
      ),
    ).toBeNull();
    expect(
      resolveRegisteredCallTool(api, createContext({ messageChannel: "telegram" })),
    ).toBeNull();
    expect(
      resolveRegisteredCallTool(api, createContext({ requesterSenderId: undefined })),
    ).toBeNull();
    expect(resolveRegisteredCallTool(api, createContext())?.name).toBe("whatsapp_call");
  });

  it("reports the companion setup without exposing a recipient argument", async () => {
    defaultDependencyMocks.binaryFound = false;
    const tool = resolveRegisteredCallTool(createApi(), createContext());

    const result = await tool?.execute("call-1", { action: "status" });
    expect(result?.details).toMatchObject({
      binaryFound: false,
      sessionStoreFound: false,
      accountId: "default",
      stateDir,
      setupCommand: `mkdir -p ${quotePosixShellArgForExpected(stateDir)} && chmod 700 ${quotePosixShellArgForExpected(stateDir)} && meowcaller pair --store ${quotePosixShellArgForExpected(path.join(stateDir, "wa-voip.db"))}`,
    });
    expect(JSON.stringify(tool?.parameters)).not.toContain('"to"');
  });

  it("synthesizes a private WAV and calls only the current requester", async () => {
    await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
    let audioPath: string | undefined;
    const runCommand = vi.fn(async (argv: string[]) => {
      const commandAudioPath = argv.at(-1);
      if (!commandAudioPath) {
        throw new Error("missing audio path");
      }
      audioPath = commandAudioPath;
      const wav = await fs.readFile(commandAudioPath);
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect(wav.readUInt32LE(40)).toBe(48_000);
      expect(wav.subarray(44)).toEqual(Buffer.alloc(48_000, 1));
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    }) as OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];
    const tool = resolveRegisteredCallTool(createApi({ runCommand }), createContext());

    const result = await tool?.execute("call-2", {
      action: "call",
      message: "The build finished successfully.",
    });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(runCommand).mock.calls[0]?.[0]).toEqual([
      "meowcaller",
      "notify",
      "--store",
      path.join(stateDir, "wa-voip.db"),
      "--answer-timeout",
      "45s",
      "--max-duration",
      "65s",
      "+15551234567",
      audioPath,
    ]);
    expect(result?.details).toMatchObject({
      completed: true,
      recipient: "current WhatsApp requester",
      callWindowSeconds: 116,
      ttsProvider: "openai",
    });
    expect(audioPath).toBeDefined();
    await expect(fs.stat(path.dirname(audioPath ?? ""))).rejects.toThrow();
  });

  it("resolves a requester LID through the active WhatsApp account", async () => {
    await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
    const runCommand = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    })) as OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];
    runtimeContextMocks.controllers.set("default", {
      getActiveListener: () => null,
      getCurrentSock: () => ({
        signalRepository: {
          lidMapping: {
            getPNForLID: vi.fn(async () => "15551234567@s.whatsapp.net"),
          },
        },
      }),
      getSelfIdentity: () => null,
    });

    const tool = resolveRegisteredCallTool(
      createApi({ runCommand }),
      createContext({ requesterSenderId: "123456789@lid" }),
    );
    await expect(
      tool?.execute("call-lid", { action: "call", message: "Hello" }),
    ).resolves.toBeDefined();
    expect(vi.mocked(runCommand).mock.calls[0]?.[0]).toContain("+15551234567");
  });

  it("rejects calling the linked WhatsApp identity itself", async () => {
    await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
    runtimeContextMocks.controllers.set("default", {
      getActiveListener: () => null,
      getCurrentSock: () => null,
      getSelfIdentity: () => ({ e164: "+15551234567" }),
    });
    const tool = resolveRegisteredCallTool(createApi(), createContext());

    await expect(tool?.execute("call-self", { action: "call", message: "Hello" })).rejects.toThrow(
      "WhatsApp cannot call the linked account itself",
    );
  });

  it("rejects an early MeowCaller failure and removes the temporary audio", async () => {
    await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
    let audioPath: string | undefined;
    const runCommand = vi.fn(async (argv: string[]) => {
      audioPath = argv.at(-1);
      return {
        stdout: "",
        stderr: "sensitive upstream diagnostics",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    }) as OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];
    const tool = resolveRegisteredCallTool(createApi({ runCommand }), createContext());

    await expect(tool?.execute("call-3", { action: "call", message: "Hello" })).rejects.toThrow(
      "MeowCaller did not complete the call (code 1)",
    );
    expect(audioPath).toBeDefined();
    await expect(fs.stat(path.dirname(audioPath ?? ""))).rejects.toThrow();
  });

  it("does not report success when MeowCaller times out", async () => {
    await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
    const runCommand = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 124,
      signal: "SIGTERM" as const,
      killed: true,
      termination: "timeout" as const,
    })) as OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];
    const tool = resolveRegisteredCallTool(createApi({ runCommand }), createContext());

    await expect(
      tool?.execute("call-unpaired", { action: "call", message: "Hello" }),
    ).rejects.toThrow("MeowCaller exceeded the bounded WhatsApp call window");
  });

  it.each(["ulaw_8000", "raw-8khz-8bit-mono-mulaw"])(
    "decodes %s telephony audio through the registered tool",
    async (outputFormat) => {
      await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
      const runCommand = vi.fn(async (argv: string[]) => {
        const wav = await fs.readFile(argv.at(-1) ?? "");
        expect(wav.subarray(44).length).toBe(4);
        expect(wav.readInt16LE(44)).toBe(0);
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }) as OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];
      const tool = resolveRegisteredCallTool(
        createApi({
          runCommand,
          speech: {
            audioBuffer: Buffer.from([0xff, 0x7f]),
            outputFormat,
            sampleRate: 8_000,
          },
        }),
        createContext(),
      );

      await expect(
        tool?.execute("call-ulaw", { action: "call", message: "Hello" }),
      ).resolves.toBeDefined();
    },
  );

  it.each([
    {
      name: "unsupported format",
      speech: { audioBuffer: Buffer.alloc(2), outputFormat: "mp3", sampleRate: 24_000 },
      message: "unsupported telephony format",
    },
    {
      name: "invalid PCM framing",
      speech: { audioBuffer: Buffer.alloc(3), outputFormat: "pcm", sampleRate: 24_000 },
      message: "invalid 16-bit PCM",
    },
    {
      name: "overlong audio",
      speech: {
        audioBuffer: Buffer.alloc(24_000 * 2 * 61),
        outputFormat: "pcm",
        sampleRate: 24_000,
      },
      message: "60-second WhatsApp call limit",
    },
  ])("rejects $name through the registered tool", async ({ speech, message }) => {
    await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
    const tool = resolveRegisteredCallTool(createApi({ speech }), createContext());

    await expect(
      tool?.execute("call-invalid", { action: "call", message: "Hello" }),
    ).rejects.toThrow(message);
  });
});
