import { dispatchWidgetPrompt } from "../../components/mcp-app-security.ts";

type BoardWidgetBridgeRequest = {
  type: "openclaw:widget-bridge-request";
  id: string;
  method: string;
  params: unknown;
  ticket: string;
};

export type BoardWidgetBridgeGatewayClient = {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

type PromptDispatcher = typeof dispatchWidgetPrompt;

const STATE_PAYLOAD_MAX_BYTES = 8 * 1024;
const STATE_COALESCE_WINDOW_MS = 5_000;
const STATE_RATE_WINDOW_MS = 60_000;
const STATE_RATE_MAX_ATTEMPTS = 12;

export function isBoardWidgetBridgeRequest(value: unknown): value is BoardWidgetBridgeRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<BoardWidgetBridgeRequest>;
  return (
    request.type === "openclaw:widget-bridge-request" &&
    typeof request.id === "string" &&
    request.id.length > 0 &&
    request.id.length <= 128 &&
    typeof request.method === "string" &&
    typeof request.ticket === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("widget host request params are invalid");
  }
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`widget host request ${key} is required`);
  }
  return value;
}

export class BoardWidgetBridgeController {
  private frame: HTMLIFrameElement;
  private ticket: string;
  private readonly client: BoardWidgetBridgeGatewayClient;
  private readonly rateKey: string;
  private readonly confirmPrompt: (text: string) => boolean;
  private readonly dispatchPrompt: PromptDispatcher;
  private readonly now: () => number;
  private readonly recentStatePayloads = new Map<string, number>();
  private readonly pendingStates = new Map<string, Promise<unknown>>();
  private stateAttemptTimes: number[] = [];

  constructor(options: {
    frame: HTMLIFrameElement;
    ticket: string;
    client: BoardWidgetBridgeGatewayClient;
    rateKey: string;
    confirmPrompt: (text: string) => boolean;
    dispatchPrompt?: PromptDispatcher;
    now?: () => number;
  }) {
    this.frame = options.frame;
    this.ticket = options.ticket;
    this.client = options.client;
    this.rateKey = options.rateKey;
    this.confirmPrompt = options.confirmPrompt;
    this.dispatchPrompt = options.dispatchPrompt ?? dispatchWidgetPrompt;
    this.now = options.now ?? Date.now;
  }

  updateIdentity(frame: HTMLIFrameElement, ticket: string): void {
    this.frame = frame;
    this.ticket = ticket;
  }

  private async emitState(payload: unknown): Promise<unknown> {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      throw new Error("widget state payload must be JSON");
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > STATE_PAYLOAD_MAX_BYTES) {
      throw new Error(`widget state payload exceeds ${STATE_PAYLOAD_MAX_BYTES} UTF-8 bytes`);
    }
    const nowMs = this.now();
    for (const [recentPayload, emittedAtMs] of this.recentStatePayloads) {
      if (nowMs - emittedAtMs >= STATE_COALESCE_WINDOW_MS) {
        this.recentStatePayloads.delete(recentPayload);
      }
    }
    if (this.recentStatePayloads.has(serialized)) {
      return { ok: true, appended: false, coalesced: true };
    }
    const pendingState = this.pendingStates.get(serialized);
    if (pendingState) {
      return await pendingState;
    }
    this.stateAttemptTimes = this.stateAttemptTimes.filter(
      (attemptAtMs) => nowMs - attemptAtMs < STATE_RATE_WINDOW_MS,
    );
    if (this.stateAttemptTimes.length >= STATE_RATE_MAX_ATTEMPTS) {
      throw new Error("widget state emission rate limit exceeded");
    }
    this.stateAttemptTimes.push(nowMs);
    const request = this.client.request("board.event", { ticket: this.ticket, payload });
    this.pendingStates.set(serialized, request);
    try {
      const result = await request;
      this.recentStatePayloads.set(serialized, this.now());
      return result;
    } finally {
      if (this.pendingStates.get(serialized) === request) {
        this.pendingStates.delete(serialized);
      }
    }
  }

  async handle(
    request: BoardWidgetBridgeRequest,
    options: { promptUserActivated?: boolean; isCurrent?: () => boolean } = {},
  ): Promise<unknown> {
    if (request.ticket !== this.ticket) {
      throw new Error("widget view ticket does not match the active frame");
    }
    const params = asRecord(request.params);
    switch (request.method) {
      case "prompt.send": {
        if (options.promptUserActivated !== true) {
          throw new Error("widget prompt requires active user interaction");
        }
        const text = requiredString(params, "text");
        const authorization = (await this.client.request("board.prompt.authorize", {
          ticket: this.ticket,
        })) as { confirmationRequired?: boolean };
        if (options.isCurrent?.() === false) {
          throw new Error("widget prompt request is no longer current");
        }
        const accepted = this.dispatchPrompt(
          this.frame,
          text,
          this.rateKey,
          authorization.confirmationRequired === false ? undefined : this.confirmPrompt,
        );
        if (!accepted) {
          throw new Error("widget prompt was not accepted");
        }
        return { ok: true };
      }
      case "state.emit":
        return await this.emitState(params.payload);
      case "data.read": {
        const bindingId = requiredString(params, "bindingId");
        const bindingParams = params.params;
        if (
          bindingParams !== undefined &&
          (!bindingParams || typeof bindingParams !== "object" || Array.isArray(bindingParams))
        ) {
          throw new Error("widget data binding params are invalid");
        }
        return await this.client.request("board.data.read", {
          ticket: this.ticket,
          bindingId,
          ...(bindingParams ? { params: bindingParams as Record<string, unknown> } : {}),
        });
      }
      case "cron.trigger":
        return await this.client.request("board.action", {
          ticket: this.ticket,
          action: "cron.trigger",
          jobId: requiredString(params, "jobId"),
        });
      default:
        throw new Error(`widget host method is not supported: ${request.method}`);
    }
  }
}
