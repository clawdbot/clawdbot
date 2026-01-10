import http from "node:http";
import { URL } from "node:url";

import type { VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private config: VoiceCallConfig;
  private manager: CallManager;
  private provider: VoiceCallProvider;

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
  ) {
    this.config = config;
    this.manager = manager;
    this.provider = provider;

    // Initialize media stream handler if streaming is enabled
    if (config.streaming?.enabled) {
      this.initializeMediaStreaming();
    }
  }

  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler(): MediaStreamHandler | null {
    return this.mediaStreamHandler;
  }

  /**
   * Initialize media streaming with OpenAI Realtime STT.
   */
  private initializeMediaStreaming(): void {
    const apiKey =
      this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.warn(
        "[voice-call] Streaming enabled but no OpenAI API key found",
      );
      return;
    }

    const sttProvider = new OpenAIRealtimeSTTProvider({
      apiKey,
      model: this.config.streaming?.sttModel,
      silenceDurationMs: this.config.streaming?.silenceDurationMs,
      vadThreshold: this.config.streaming?.vadThreshold,
    });

    const streamConfig: MediaStreamConfig = {
      sttProvider,
      onTranscript: (providerCallId, transcript) => {
        console.log(
          `[voice-call] Transcript for ${providerCallId}: ${transcript}`,
        );

        // Look up our internal call ID from the provider call ID
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(
            `[voice-call] No active call found for provider ID: ${providerCallId}`,
          );
          return;
        }

        // Create a speech event and process it through the manager
        const event: NormalizedEvent = {
          id: `stream-transcript-${Date.now()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
          isFinal: true,
        };
        this.manager.processEvent(event);

        // Auto-respond for inbound calls
        if (call.direction === "inbound") {
          this.handleInboundResponse(call.callId, transcript).catch((err) => {
            console.warn(`[voice-call] Failed to auto-respond:`, err);
          });
        }
      },
      onPartialTranscript: (callId, partial) => {
        console.log(`[voice-call] Partial for ${callId}: ${partial}`);
      },
      onConnect: (callId, streamSid) => {
        console.log(
          `[voice-call] Media stream connected: ${callId} -> ${streamSid}`,
        );
        // Register stream with provider for TTS routing
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(
            callId,
            streamSid,
          );
        }

        // Speak initial message if one was provided when call was initiated
        // Use setTimeout to allow stream setup to complete
        setTimeout(() => {
          this.manager.speakInitialMessage(callId).catch((err) => {
            console.warn(`[voice-call] Failed to speak initial message:`, err);
          });
        }, 500);
      },
      onDisconnect: (callId) => {
        console.log(`[voice-call] Media stream disconnected: ${callId}`);
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).unregisterCallStream(callId);
        }
      },
    };

    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    console.log("[voice-call] Media streaming initialized");
  }

  /**
   * Start the webhook server.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming?.streamPath || "/voice/stream";

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          console.error("[voice-call] Webhook error:", err);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      // Handle WebSocket upgrades for media streams
      if (this.mediaStreamHandler) {
        this.server.on("upgrade", (request, socket, head) => {
          const url = new URL(
            request.url || "/",
            `http://${request.headers.host}`,
          );

          if (url.pathname === streamPath) {
            console.log("[voice-call] WebSocket upgrade for media stream");
            this.mediaStreamHandler?.handleUpgrade(request, socket, head);
          } else {
            socket.destroy();
          }
        });
      }

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = `http://${bind}:${port}${webhookPath}`;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          console.log(
            `[voice-call] Media stream WebSocket on ws://${bind}:${port}${streamPath}`,
          );
        }
        resolve(url);
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Check path
    if (!url.pathname.startsWith(webhookPath)) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    // Read body
    const body = await this.readBody(req);

    // Build webhook context
    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
    };

    // Verify signature
    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      console.warn(
        `[voice-call] Webhook verification failed: ${verification.reason}`,
      );
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Parse events
    const result = this.provider.parseWebhookEvent(ctx);

    // Process each event
    for (const event of result.events) {
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(
          `[voice-call] Error processing event ${event.type}:`,
          err,
        );
      }
    }

    // Send response
    res.statusCode = result.statusCode || 200;

    if (result.providerResponseHeaders) {
      for (const [key, value] of Object.entries(
        result.providerResponseHeaders,
      )) {
        res.setHeader(key, value);
      }
    }

    res.end(result.providerResponseBody || "OK");
  }

  /**
   * Read request body as string.
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  /**
   * Handle auto-response for inbound calls using AI.
   */
  private async handleInboundResponse(
    callId: string,
    userMessage: string,
  ): Promise<void> {
    console.log(
      `[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`,
    );

    // Get call context for conversation history
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    // Build conversation history from transcript
    const messages = call.transcript.map((entry) => ({
      role:
        entry.speaker === "bot" ? ("assistant" as const) : ("user" as const),
      content: entry.text,
    }));

    // Generate response using OpenAI (simple approach)
    const apiKey =
      this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("[voice-call] No OpenAI API key for auto-response");
      return;
    }

    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `You are Haki, a helpful voice assistant. Keep responses brief and conversational (1-2 sentences). You're on a phone call, so be natural and friendly. The caller's phone number is ${call.from}.`,
              },
              ...messages,
            ],
            max_tokens: 150,
            temperature: 0.7,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        console.error(`[voice-call] OpenAI API error: ${error}`);
        return;
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const aiResponse = data.choices[0]?.message?.content;

      if (aiResponse) {
        console.log(`[voice-call] AI response: "${aiResponse}"`);
        await this.manager.speak(callId, aiResponse);
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    }
  }
}

/**
 * Resolve the current machine's Tailscale DNS name.
 */
export type TailscaleSelfInfo = {
  dnsName: string | null;
  nodeId: string | null;
};

export async function getTailscaleSelfInfo(): Promise<TailscaleSelfInfo | null> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    const proc = spawn("tailscale", ["status", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data;
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const status = JSON.parse(output);
        const dnsName = status.Self?.DNSName?.replace(/\.$/, "") || null;
        const nodeId = status.Self?.ID || null;
        resolve({ dnsName, nodeId });
      } catch {
        resolve(null);
      }
    });
  });
}

export async function getTailscaleDnsName(): Promise<string | null> {
  const info = await getTailscaleSelfInfo();
  return info?.dnsName ?? null;
}

export async function setupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
  localUrl: string;
}): Promise<string | null> {
  const { spawn } = await import("node:child_process");

  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    console.warn("[voice-call] Could not get Tailscale DNS name");
    return null;
  }

  return new Promise((resolve) => {
    const proc = spawn(
      "tailscale",
      [opts.mode, "--bg", "--yes", "--set-path", opts.path, opts.localUrl],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, 2500);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const publicUrl = `https://${dnsName}${opts.path}`;
        console.log(`[voice-call] Tailscale ${opts.mode} active: ${publicUrl}`);
        resolve(publicUrl);
      } else {
        console.warn(`[voice-call] Tailscale ${opts.mode} failed`);
        resolve(null);
      }
    });
  });
}

export async function cleanupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
}): Promise<void> {
  const { spawn } = await import("node:child_process");

  await new Promise<void>((resolve) => {
    const proc = spawn("tailscale", [opts.mode, "off", opts.path], {
      stdio: "ignore",
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 2500);

    proc.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Setup Tailscale serve/funnel for the webhook server.
 * This is a helper that shells out to `tailscale serve` or `tailscale funnel`.
 */
export async function setupTailscaleExposure(
  config: VoiceCallConfig,
): Promise<string | null> {
  if (config.tailscale.mode === "off") {
    return null;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  // Include the path suffix so tailscale forwards to the correct endpoint
  // (tailscale strips the mount path prefix when proxying)
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  return setupTailscaleExposureRoute({
    mode,
    path: config.tailscale.path,
    localUrl,
  });
}

/**
 * Cleanup Tailscale serve/funnel.
 */
export async function cleanupTailscaleExposure(
  config: VoiceCallConfig,
): Promise<void> {
  if (config.tailscale.mode === "off") {
    return;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
}
