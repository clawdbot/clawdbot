// WhatsApp call tool tests cover requester binding, audio framing, and process cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppCallTool, testing } from "./agent-tools-call.js";

const runtimeContextMocks = vi.hoisted(() => ({
  controllers: new Map<string, unknown>(),
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

describe("WhatsApp call tool", () => {
  let stateDir: string;

  beforeEach(async () => {
    runtimeContextMocks.controllers.clear();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-call-test-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("is opt-in and available only for a trusted WhatsApp requester", () => {
    const api = createApi();

    expect(createWhatsAppCallTool(api, createContext({ config: {} }))).toBeNull();
    expect(
      createWhatsAppCallTool(
        api,
        createContext({
          config: { channels: { whatsapp: { actions: { calls: false } } } },
        }),
      ),
    ).toBeNull();
    expect(createWhatsAppCallTool(api, createContext({ messageChannel: "telegram" }))).toBeNull();
    expect(createWhatsAppCallTool(api, createContext({ requesterSenderId: undefined }))).toBeNull();
    expect(createWhatsAppCallTool(api, createContext())?.name).toBe("whatsapp_call");
  });

  it("reports the separate companion setup without exposing a recipient argument", async () => {
    const tool = testing.createWhatsAppCallToolWithDependencies(createApi(), createContext(), {
      detectMeowCaller: async () => false,
      resolveStateDir: () => stateDir,
    });

    const result = await tool?.execute("call-1", { action: "status" });
    expect(result?.details).toMatchObject({
      binaryFound: false,
      sessionStoreFound: false,
      accountId: "default",
      stateDir,
    });
    expect(result?.details).toMatchObject({
      setupCommand: expect.stringContaining("meowcaller pair --store"),
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
    const api = createApi({ runCommand });
    const tool = testing.createWhatsAppCallToolWithDependencies(api, createContext(), {
      detectMeowCaller: async () => true,
      resolveStateDir: () => stateDir,
    });

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
    const controller = {
      getActiveListener: () => null,
      getCurrentSock: () =>
        ({
          signalRepository: {
            lidMapping: {
              getPNForLID: vi.fn(async () => "15551234567@s.whatsapp.net"),
            },
          },
        }) as never,
      getSelfIdentity: () => null,
    };
    runtimeContextMocks.controllers.set("default", controller);
    try {
      await expect(
        testing.resolveRequesterE164({
          accountId: "default",
          cfg: {},
          requesterSenderId: "123456789@lid",
        }),
      ).resolves.toBe("+15551234567");
    } finally {
      runtimeContextMocks.controllers.delete("default");
    }
  });

  it("rejects calling the linked WhatsApp identity itself", async () => {
    await fs.writeFile(path.join(stateDir, "wa-voip.db"), "sqlite");
    const controller = {
      getActiveListener: () => null,
      getCurrentSock: () => null,
      getSelfIdentity: () => ({ e164: "+15551234567" }),
    };
    runtimeContextMocks.controllers.set("default", controller);
    try {
      const tool = testing.createWhatsAppCallToolWithDependencies(createApi(), createContext(), {
        detectMeowCaller: async () => true,
        resolveStateDir: () => stateDir,
      });
      await expect(
        tool?.execute("call-self", { action: "call", message: "Hello" }),
      ).rejects.toThrow("WhatsApp cannot call the linked account itself");
    } finally {
      runtimeContextMocks.controllers.delete("default");
    }
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
    const tool = testing.createWhatsAppCallToolWithDependencies(
      createApi({ runCommand }),
      createContext(),
      {
        detectMeowCaller: async () => true,
        resolveStateDir: () => stateDir,
      },
    );

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
    const tool = testing.createWhatsAppCallToolWithDependencies(
      createApi({ runCommand }),
      createContext(),
      {
        detectMeowCaller: async () => true,
        resolveStateDir: () => stateDir,
      },
    );

    await expect(
      tool?.execute("call-unpaired", { action: "call", message: "Hello" }),
    ).rejects.toThrow("MeowCaller exceeded the bounded WhatsApp call window");
  });

  it.each(["ulaw_8000", "raw-8khz-8bit-mono-mulaw"])(
    "decodes %s telephony audio to PCM",
    (outputFormat) => {
      const pcm = testing.normalizeTelephonyPcm(Buffer.from([0xff, 0x7f]), outputFormat);
      expect(pcm.length).toBe(4);
      expect(pcm.readInt16LE(0)).toBe(0);
    },
  );

  it("writes valid PCM headers and enforces the call window", () => {
    const wav = testing.wrapPcm16MonoInWav(Buffer.alloc(4), 16_000);
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(() => testing.wrapPcm16MonoInWav(Buffer.alloc(3), 16_000)).toThrow("invalid 16-bit PCM");
    expect(() => testing.normalizeTelephonyPcm(Buffer.alloc(2), "mp3")).toThrow(
      "unsupported telephony format",
    );
    expect(testing.resolveCallWindowMs(0, 24_000)).toBe(115_000);
    expect(testing.resolveCallWindowMs(24_000 * 2 * 60, 24_000)).toBe(175_000);
    expect(() => testing.resolveCallWindowMs(24_000 * 2 * 61, 24_000)).toThrow(
      "60-second WhatsApp call limit",
    );
  });

  it("shell-quotes the pairing command", () => {
    expect(
      testing.resolveSetupCommand("/tmp/call dir/$HOME's", "/tmp/call dir/$HOME's/wa-voip.db"),
    ).toBe(
      `mkdir -p '/tmp/call dir/$HOME'"'"'s' && chmod 700 '/tmp/call dir/$HOME'"'"'s' && meowcaller pair --store '/tmp/call dir/$HOME'"'"'s/wa-voip.db'`,
    );
    expect(
      testing.resolveSetupCommand(
        String.raw`C:\Users\Peter O'Neil\calls`,
        String.raw`C:\Users\Peter O'Neil\calls\wa-voip.db`,
        "win32",
      ),
    ).toBe(String.raw`meowcaller pair --store 'C:\Users\Peter O''Neil\calls\wa-voip.db'`);
  });
});
