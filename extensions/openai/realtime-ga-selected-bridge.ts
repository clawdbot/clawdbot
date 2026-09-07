import type {
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
  RealtimeVoiceUserMessageOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { RealtimeVoiceSessionLifecycle } from "openclaw/plugin-sdk/realtime-voice-provider";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-auth.js";
import { OpenAIRealtimeGaWebRtcBridge } from "./realtime-ga-webrtc-bridge.js";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { isOpenAIGptLiveModel } from "./realtime-quicksilver.js";
import { OpenAIRealtimeBridge } from "./realtime-voice-bridge.js";
import {
  hasOpenAIRealtimePlatformAuthInput,
  OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED,
  resolveOpenAIRealtimePlatformAuth,
  type OpenAIRealtimeVoiceBridgeConfig,
} from "./realtime-voice-session-policy.js";

/**
 * Private factory seam for normalized GA Gateway configs. Construct after Gateway
 * admission; connect owns selection and retirement across every awaited boundary.
 * Explicit Platform/Azure routes remain WebSocket. OAuth is GA WebRTC, never WS.
 */
export function createOpenAIRealtimeSelectedBridge(
  config: OpenAIRealtimeVoiceBridgeConfig,
  runtime: OpenAIRealtimeHost,
): RealtimeVoiceBridge {
  return new OpenAIRealtimeSelectedBridge(config, runtime);
}

class OpenAIRealtimeSelectedBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = true;
  readonly supportsToolResultSuppression = true;
  private readonly lifecycle = new RealtimeVoiceSessionLifecycle("OpenAI selected realtime");
  private bridge?: RealtimeVoiceBridge;
  private closed = false;
  private failure?: Error;
  private providerError?: Error;
  private rejectStartup?: (error: Error) => void;
  private mediaTimestamp = 0;

  constructor(
    private readonly config: OpenAIRealtimeVoiceBridgeConfig,
    private readonly runtime: OpenAIRealtimeHost,
  ) {}

  get supportsReadback(): boolean {
    return !(this.config.azureEndpoint && this.config.azureDeployment);
  }

  connect(): Promise<void> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.resolve();
    }
    return this.lifecycle.connect((connection) => {
      const attempt = this.lifecycle.createConnectAttempt({
        connection,
        timeoutMs: 30_000,
        timeoutError: () => new Error("OpenAI realtime authentication/startup timed out"),
        onTimeout: () =>
          this.fail(new Error("OpenAI realtime authentication/startup timed out"), connection),
        onAbort: () => this.bridge?.close(),
      });
      this.rejectStartup = (error) => attempt.reject(error);
      attempt.startTimeout();
      void this.start(connection)
        .then(() => {
          attempt.resolve(this.lifecycle.isReady());
        })
        .catch((error: unknown) => {
          if (!this.lifecycle.acceptsEvents(connection)) {
            return;
          }
          const failure =
            error instanceof Error ? error : new Error("OpenAI realtime startup failed");
          attempt.reject(failure);
          this.fail(failure, connection);
        });
      return attempt.promise;
    });
  }

  private async start(connection: RealtimeVoiceSessionConnection): Promise<void> {
    const accepts = () => !this.closed && this.lifecycle.acceptsEvents(connection);
    if (isOpenAIGptLiveModel(this.config.model)) {
      throw new Error("Native GPT-Live requires its native bridge");
    }
    const config: OpenAIRealtimeVoiceBridgeConfig = {
      ...this.config,
      onAudio: (audio, metadata) => {
        if (accepts()) {
          this.config.onAudio(audio, metadata);
        }
      },
      onClearAudio: (reason) => {
        if (accepts()) {
          this.config.onClearAudio(reason);
        }
      },
      onTranscript: (role, text, final) => {
        if (accepts()) {
          this.config.onTranscript?.(role, text, final);
        }
      },
      onToolCall: (event) => {
        if (accepts()) {
          this.config.onToolCall?.(event);
        }
      },
      onEvent: (event) => {
        if (accepts()) {
          this.config.onEvent?.(event);
        }
      },
      onResponseDone: (outcome) => {
        if (accepts()) {
          this.config.onResponseDone?.(outcome);
        }
      },
      onMark: (mark, acknowledge) => {
        if (accepts()) {
          this.config.onMark?.(mark, () => {
            if (accepts()) {
              acknowledge?.();
            }
          });
        }
      },
      onError: (error) => {
        if (accepts()) {
          this.providerError = error;
          this.config.onError?.(error);
        }
      },
      onClose: (reason) => {
        if (!accepts()) {
          return;
        }
        this.closed = true;
        if (reason === "error") {
          this.failure =
            this.providerError ?? new Error("OpenAI realtime selected transport failed");
          this.rejectStartup?.(this.failure);
        }
        if (this.lifecycle.close(connection, reason === "error" ? "error" : "completed")) {
          this.config.onClose?.(reason);
        }
      },
      onReady: () => {
        if (!accepts() || !this.lifecycle.ready(connection)) {
          return;
        }
        this.config.onReady?.();
        if (accepts()) {
          for (const audio of this.lifecycle.drainPendingAudio()) {
            this.bridge?.sendAudio(audio);
          }
        }
      },
    };
    // Endpoint-only Azure uses the GA-compatible WS dialect. Partial authored
    // Azure routes also remain with that owner; OAuth must not redirect them
    // to the public OpenAI call endpoint. Validation stays with the existing WS path.
    if (config.azureEndpoint || config.azureDeployment || config.azureApiVersion) {
      this.bridge = new OpenAIRealtimeBridge(config, this.runtime);
    } else {
      const params = { configuredApiKey: config.apiKey, cfg: config.cfg, agentId: config.agentId };
      // Same selection order and authored-input refusal as the GA browser owner.
      // Unlike native GPT-Live, an existing OAuth account cannot displace Platform.
      const platform = await resolveOpenAIRealtimePlatformAuth(params, this.runtime).catch(() => {
        throw new Error("OpenAI realtime Platform authentication could not be resolved");
      });
      if (!accepts()) {
        return;
      }
      if (platform.status === "available") {
        this.bridge = new OpenAIRealtimeBridge({ ...config, apiKey: platform.value }, this.runtime);
      } else {
        if (hasOpenAIRealtimePlatformAuthInput(params, this.runtime)) {
          throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
        }
        const auth = await resolveOpenAIChatGptSubscriptionAuth(
          {
            cfg: config.cfg,
            agentDir:
              config.cfg && config.agentId
                ? this.runtime.resolveAgentDir(config.cfg, config.agentId)
                : undefined,
          },
          this.runtime,
        ).catch(() => {
          throw new Error(
            "OpenAI realtime selected ChatGPT account could not be resolved; reconnect that account",
          );
        });
        if (!accepts()) {
          return;
        }
        if (!auth) {
          throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
        }
        this.bridge = new OpenAIRealtimeGaWebRtcBridge(config, this.runtime, auth);
      }
    }
    if (!accepts()) {
      this.bridge?.close();
      return;
    }
    this.bridge.setMediaTimestamp(this.mediaTimestamp);
    await this.bridge.connect();
    if (!accepts()) {
      this.bridge.close();
    }
  }

  private fail(error: Error, connection: RealtimeVoiceSessionConnection): void {
    if (!this.lifecycle.acceptsEvents(connection)) {
      return;
    }
    this.failure = error;
    this.rejectStartup?.(error);
    this.closed = true;
    this.lifecycle.failure(connection);
    this.bridge?.close();
    try {
      this.config.onError?.(error);
    } finally {
      if (this.lifecycle.close(connection, "error")) {
        this.config.onClose?.("error");
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const connection = this.lifecycle.currentConnection();
    this.lifecycle.cancel();
    this.bridge?.close();
    if (connection && this.lifecycle.close(connection, "completed")) {
      this.config.onClose?.("completed");
    }
  }
  isConnected(): boolean {
    return !this.closed && this.lifecycle.isReady() && this.bridge?.isConnected() === true;
  }
  sendAudio(audio: Buffer): void {
    if (this.closed) {
      return;
    }
    if (this.isConnected()) {
      this.bridge?.sendAudio(audio);
    } else {
      this.lifecycle.enqueuePendingAudio(audio);
    }
  }
  setMediaTimestamp(ts: number): void {
    this.mediaTimestamp = ts;
    if (!this.closed) {
      this.bridge?.setMediaTimestamp(ts);
    }
  }
  sendUserMessage(text: string, options?: RealtimeVoiceUserMessageOptions): void {
    if (this.isConnected()) {
      this.bridge?.sendUserMessage?.(text, options);
    }
  }
  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void | Promise<void> {
    if (this.isConnected()) {
      return this.bridge?.submitToolResult(callId, result, options);
    }
  }
  triggerGreeting(instructions?: string): void {
    if (this.isConnected()) {
      this.bridge?.triggerGreeting?.(instructions);
    }
  }
  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    if (this.isConnected()) {
      this.bridge?.handleBargeIn?.(options);
    }
  }
  acknowledgeMark(mark?: string): void {
    if (this.isConnected()) {
      this.bridge?.acknowledgeMark?.(mark);
    }
  }
}
