import type { Command } from "commander";
import { callGateway } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeSpeechProviderId } from "../../tts/provider-registry.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import {
  emitJsonOrText,
  formatEnvelopeForText,
  providerSummaryText,
  resolveModelRefOverride,
  resolveTransport,
} from "./shared.js";
import {
  runTtsConvert,
  runTtsPersonas,
  runTtsProviders,
  runTtsStateMutation,
  runTtsVoices,
} from "./tts-runtime.js";

function registerTransportTtsCommand(
  command: Command,
  defaultTransport: "local" | "gateway",
  run: (opts: Record<string, unknown>, transport: "local" | "gateway") => Promise<unknown>,
  formatText: (value: unknown) => string = (value) => JSON.stringify(value, null, 2),
): void {
  command
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport,
        });
        const result = await run(opts, transport);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatText);
      });
    });
}

export function registerTtsCapabilityCommands(capability: Command): void {
  const tts = capability.command("tts").description("Text to speech");

  registerTransportTtsCommand(
    tts
      .command("convert")
      .description("Convert text to speech")
      .requiredOption("--text <text>", "Input text")
      .option("--channel <id>", "Channel hint")
      .option("--voice <id>", "Voice hint")
      .option("--provider <id>", "Speech provider id")
      .option("--model <provider/model>", "Model override")
      .option("--output <path>", "Output path"),
    "local",
    async (opts, transport) => {
      const modelRef = resolveModelRefOverride(opts.model as string | undefined);
      if (opts.model && !modelRef.provider) {
        throw new Error("TTS model overrides must use the form <provider/model>.");
      }
      const provider = normalizeSpeechProviderId(
        typeof opts.provider === "string" && opts.provider.trim()
          ? opts.provider.trim()
          : modelRef.provider,
      );
      const modelProvider = normalizeSpeechProviderId(modelRef.provider);
      if (provider && modelProvider && provider !== modelProvider) {
        throw new Error("TTS --provider must match the provider in --model.");
      }
      return await runTtsConvert({
        text: String(opts.text),
        channel: opts.channel as string | undefined,
        provider,
        modelId: modelProvider ? modelRef.model : undefined,
        voiceId: opts.voice as string | undefined,
        output: opts.output as string | undefined,
        transport,
      });
    },
    formatEnvelopeForText,
  );

  tts
    .command("voices")
    .description("List voices for a TTS provider")
    .option("--provider <id>", "Speech provider id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const voices = await runTtsVoices(opts.provider as string | undefined);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), voices, providerSummaryText);
      });
    });

  for (const [name, description, run] of [
    ["providers", "List speech providers", runTtsProviders],
    ["personas", "List TTS personas", runTtsPersonas],
  ] as const) {
    registerTransportTtsCommand(
      tts.command(name).description(description),
      "local",
      (_, transport) => run(transport),
    );
  }

  tts
    .command("status")
    .description("Show TTS status")
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          gateway: Boolean(opts.gateway),
          supported: ["gateway"],
          defaultTransport: "gateway",
        });
        const result = await callGateway({
          method: "tts.status",
          timeoutMs: 30_000,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), { transport, ...result }, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  for (const [commandName, capabilityId] of [
    ["enable", "tts.enable"],
    ["disable", "tts.disable"],
  ] as const) {
    registerTransportTtsCommand(
      tts
        .command(commandName)
        .description(`${commandName === "enable" ? "Enable" : "Disable"} TTS`),
      "gateway",
      (_, transport) => runTtsStateMutation({ capability: capabilityId, transport }),
    );
  }

  registerTransportTtsCommand(
    tts
      .command("set-provider")
      .description("Set the active TTS provider")
      .requiredOption("--provider <id>", "Speech provider id"),
    "gateway",
    (opts, transport) =>
      runTtsStateMutation({
        capability: "tts.set-provider",
        provider: String(opts.provider),
        transport,
      }),
  );

  registerTransportTtsCommand(
    tts
      .command("set-persona")
      .description("Set the active TTS persona")
      .option("--persona <id>", "TTS persona id")
      .option("--off", "Disable the active TTS persona", false),
    "gateway",
    (opts, transport) => {
      if (!opts.off && !opts.persona) {
        throw new Error("--persona is required unless --off is set");
      }
      return runTtsStateMutation({
        capability: "tts.set-persona",
        persona: opts.off ? null : String(opts.persona),
        transport,
      });
    },
  );
}
