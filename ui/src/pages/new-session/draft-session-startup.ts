import { SESSION_CREATE_RETRY_WINDOW_MS } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";

type DraftSessionStartupIntent = {
  params: SessionCreateParams;
  scope: string;
  startedAt: number;
  deadline: number;
  interrupted: boolean;
};

/** A creation attempt the submission flow resumes after reconnecting. */
export type DraftStartupResumption = { params: SessionCreateParams; startedAt: number };

type DraftSessionStartupResume =
  | { kind: "wait" | "expired" | "owner-changed" }
  | ({ kind: "resume" } & DraftStartupResumption);

export class DraftSessionStartup {
  private pending: DraftSessionStartupIntent | null = null;

  constructor(
    private readonly gateway: Pick<DraftGatewayState, "connected" | "sessionCreateScope">,
  ) {}

  get active(): boolean {
    return this.pending !== null;
  }

  start(params: SessionCreateParams): SessionCreateParams {
    const scope = this.gateway.sessionCreateScope;
    if (!scope) {
      return params;
    }
    if (!this.pending) {
      const startedAt = Date.now();
      this.pending = {
        params: Object.freeze({ ...params, idempotencyKey: generateUUID() }),
        scope,
        startedAt,
        deadline: startedAt + SESSION_CREATE_RETRY_WINDOW_MS,
        interrupted: false,
      };
    }
    return this.pending.params;
  }

  clear() {
    this.pending = null;
  }

  interrupt(): boolean {
    if (!this.pending || !this.matchesGateway()) {
      this.clear();
      return false;
    }
    this.pending.interrupted = true;
    return true;
  }

  retireChangedOwner(): boolean {
    if (!this.pending || this.matchesGateway()) {
      return false;
    }
    this.clear();
    return true;
  }

  resume(): DraftSessionStartupResume {
    if (!this.pending?.interrupted) {
      return { kind: "wait" };
    }
    if (Date.now() >= this.pending.deadline) {
      this.clear();
      return { kind: "expired" };
    }
    if (!this.matchesGateway()) {
      this.clear();
      return { kind: "owner-changed" };
    }
    if (!this.gateway.connected) {
      return { kind: "wait" };
    }
    this.pending.interrupted = false;
    return { kind: "resume", params: this.pending.params, startedAt: this.pending.startedAt };
  }

  private matchesGateway(): boolean {
    return this.pending?.scope === this.gateway.sessionCreateScope;
  }
}
