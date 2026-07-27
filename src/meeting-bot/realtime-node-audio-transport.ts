import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { decodeMeetingAudioBase64 } from "./audio-base64.js";
import { createMeetingOutputLoopbackVerifier } from "./output-loopback-verifier.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function createNodeMeetingRealtimeAudioTransport(params: {
  runtime: PluginRuntime;
  nodeId: string;
  bridgeId: string;
  logger: RuntimeLogger;
  /** Platform registration owns this stable command name; paired nodes call it verbatim. */
  commandName: string;
  logScope: string;
  logPrefix: string;
  audioFormat?: MeetingRealtimeAudioFormat;
}): MeetingRealtimeAudioTransport {
  let stopped = false;
  let inputStarted = false;
  let consecutiveInputErrors = 0;
  let lastInputError: string | undefined;
  let fatalSignaled = false;
  let fatalHandler: (() => void) | undefined;
  const outputLoopbackVerifier = createMeetingOutputLoopbackVerifier({
    audioFormat: params.audioFormat ?? "pcm16-24khz",
  });
  const signalFatal = () => {
    if (!fatalSignaled) {
      fatalSignaled = true;
      fatalHandler?.();
    }
  };

  const transport: MeetingRealtimeAudioTransport = {
    onFatal: (handler) => {
      fatalHandler = handler;
      if (fatalSignaled) {
        handler();
      }
    },
    startInput: (onAudio) => {
      if (inputStarted) {
        throw new Error("audio input transport already started");
      }
      inputStarted = true;
      void (async () => {
        for (;;) {
          if (stopped) {
            break;
          }
          try {
            // Long-poll cadence bounds both normal input latency and transient-error retries.
            const raw = await params.runtime.nodes.invoke({
              nodeId: params.nodeId,
              command: params.commandName,
              params: { action: "pullAudio", bridgeId: params.bridgeId, timeoutMs: 250 },
              timeoutMs: 2_000,
            });
            const result = asRecord(asRecord(raw).payload ?? raw);
            const base64 = readString(result.base64);
            if (base64) {
              const audio = decodeMeetingAudioBase64(base64, "pullAudio");
              outputLoopbackVerifier.recordInput(audio);
              onAudio(audio);
            }
            consecutiveInputErrors = 0;
            lastInputError = undefined;
            if (result.closed === true) {
              signalFatal();
              break;
            }
          } catch (error) {
            if (stopped) {
              break;
            }
            const message = formatErrorMessage(error);
            consecutiveInputErrors += 1;
            lastInputError = message;
            params.logger.warn(
              `${params.logScope} ${params.logPrefix} audio input failed (${consecutiveInputErrors}/5): ${message}`,
            );
            if (
              consecutiveInputErrors >= 5 ||
              /unknown bridgeId|bridge is not open/i.test(message)
            ) {
              signalFatal();
              break;
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 250);
            });
          }
        }
      })();
    },
    beginOutput: () => outputLoopbackVerifier.beginOutput(),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        await params.runtime.nodes.invoke({
          nodeId: params.nodeId,
          command: params.commandName,
          params: { action: "stop", bridgeId: params.bridgeId },
          timeoutMs: 5_000,
        });
      } catch (error) {
        params.logger.debug?.(
          `${params.logScope} node audio bridge stop ignored: ${formatErrorMessage(error)}`,
        );
      }
    },
    writeOutput: async (audio) => {
      outputLoopbackVerifier.recordOutput(audio);
      await params.runtime.nodes.invoke({
        nodeId: params.nodeId,
        command: params.commandName,
        params: {
          action: "pushAudio",
          bridgeId: params.bridgeId,
          base64: audio.toString("base64"),
        },
        timeoutMs: 5_000,
      });
    },
    clearOutput: async () => {
      outputLoopbackVerifier.cancelOutput();
      await params.runtime.nodes.invoke({
        nodeId: params.nodeId,
        command: params.commandName,
        params: { action: "clearAudio", bridgeId: params.bridgeId },
        timeoutMs: 5_000,
      });
    },
    dispose: async () => {
      await transport.stop();
    },
    getHealth: () => ({
      consecutiveInputErrors,
      lastInputError,
      ...outputLoopbackVerifier.getHealth(),
    }),
  };

  return transport;
}
