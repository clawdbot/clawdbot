/**
 * WebSocket JSON-RPC client for cron UI
 */

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: {
    kind: "at" | "every" | "cron";
    atMs?: number;
    everyMs?: number;
    expr?: string;
    tz?: string;
  };
  sessionTarget: "main" | "isolated";
  payload: {
    kind: "systemEvent" | "agentTurn";
    text?: string;
    message?: string;
    model?: string;
    thinking?: string;
    deliver?: boolean;
    channel?: string;
    to?: string;
    timeoutSeconds?: number;
  };
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: "ok" | "error" | "skipped";
    lastError?: string;
    lastDurationMs?: number;
    runningAtMs?: number;
  };
  createdAtMs: number;
  updatedAtMs: number;
};

export type QueueStatus = {
  enabled: boolean;
  jobs: number;
  bullmq?: {
    ready: boolean;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
    schedulers: number;
  };
};

export type CronEvent = {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished";
  status?: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  outputText?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};

export type CronRunEntry = {
  ts: number;
  jobId: string;
  action: string;
  status?: string;
  error?: string;
  summary?: string;
  outputText?: string;
  runAtMs?: number;
  durationMs?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class CronRpcClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private eventListeners = new Set<(evt: CronEvent) => void>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private connectNonce: string | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  constructor(
    private wsUrl: string,
    private token?: string,
    private password?: string,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.ws.onerror = () => {
        if (this.connectReject) {
          this.connectReject(new Error("WebSocket connection failed"));
          this.connectReject = null;
        }
      };

      this.ws.onclose = () => {
        this.handleDisconnect();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  /**
   * Send a proper gateway `connect` request in response to the challenge.
   * The gateway expects: { type: "req", id, method: "connect", params: ConnectParams }
   *
   * Note: Without device identity (Ed25519 keypair), the gateway requires
   * `auth.token` to be present to skip the device pairing check. We pass the
   * password as both `token` and `password` so the device check is satisfied
   * and the password auth mode still works.
   */
  private sendConnect(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const auth: Record<string, unknown> = {};
    if (this.token) auth.token = this.token;
    if (this.password) {
      auth.password = this.password;
      // Also set token to satisfy the device-skip check when no device identity
      if (!auth.token) auth.token = this.password;
    }

    const id = generateId();
    const msg = {
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "webchat",
          version: "dev",
          platform: navigator.platform ?? "web",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: [],
        auth: Object.keys(auth).length > 0 ? auth : undefined,
        userAgent: navigator.userAgent,
        locale: navigator.language,
      },
    };

    // Track the connect request so we can resolve/reject on response
    this.pending.set(id, {
      resolve: () => {
        if (this.connectResolve) {
          this.reconnectAttempts = 0;
          this.connectResolve();
          this.connectResolve = null;
          this.connectReject = null;
        }
      },
      reject: (err: Error) => {
        if (this.connectReject) {
          this.connectReject(err);
          this.connectReject = null;
          this.connectResolve = null;
        }
      },
    });

    this.ws.send(JSON.stringify(msg));
  }

  private handleDisconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      setTimeout(() => {
        this.connect().catch(() => {});
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  private handleMessage(data: string) {
    try {
      const msg = JSON.parse(data);

      // Handle connect challenge — respond with a proper connect request
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const payload = msg.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          this.sendConnect();
        }
        return;
      }

      // Handle RPC response (including the connect handshake response)
      if (msg.type === "res" && msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);

        if (msg.ok === false) {
          reject(new Error(msg.error?.message || "request failed"));
        } else {
          resolve(msg.payload ?? msg.result);
        }
        return;
      }

      // Handle broadcast events
      if (msg.type === "event" && msg.event === "cron") {
        const evt = msg.payload as CronEvent;
        this.eventListeners.forEach((cb) => cb(evt));
      }
    } catch (e) {
      console.error("Failed to parse message:", e);
    }
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const id = generateId();
    const request = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify(request));

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 30000);
    });
  }

  // Cron API methods
  async list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]> {
    const res = await this.call<{ jobs?: CronJob[] }>("cron.list", opts || {});
    return Array.isArray(res) ? res : (res?.jobs ?? []);
  }

  async status(): Promise<QueueStatus> {
    return this.call("cron.status");
  }

  async add(job: Partial<CronJob>): Promise<CronJob> {
    return this.call("cron.add", { job });
  }

  async update(id: string, patch: Partial<CronJob>): Promise<CronJob> {
    return this.call("cron.update", { jobId: id, patch });
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    return this.call("cron.remove", { jobId: id });
  }

  async run(id: string, mode?: "due" | "force"): Promise<{ ran: boolean }> {
    return this.call("cron.run", { jobId: id, mode });
  }

  async runs(id: string, limit = 20): Promise<CronRunEntry[]> {
    const res = await this.call<{ entries?: CronRunEntry[] }>("cron.runs", { jobId: id, limit });
    return Array.isArray(res) ? res : (res?.entries ?? []);
  }

  // Real-time subscription
  onCronEvent(callback: (evt: CronEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}

// Singleton instance
let client: CronRpcClient | null = null;

/**
 * Try to read auth credentials from the main control UI's localStorage.
 * Checks both the settings (token) and the device auth store (device token).
 */
function readMainUiAuth(): { token?: string } {
  // 1. Try main UI settings for explicit token
  try {
    const raw = window.localStorage.getItem("moltbot.control.settings.v1");
    if (raw) {
      const settings = JSON.parse(raw);
      if (settings?.token) return { token: settings.token };
    }
  } catch {
    /* ignore */
  }

  // 2. Try device auth token (issued by gateway after pairing)
  try {
    const raw = window.localStorage.getItem("moltbot.device.auth.v1");
    if (raw) {
      const store = JSON.parse(raw);
      if (store?.version === 1 && store?.tokens) {
        // Get the operator token
        const operatorToken = store.tokens?.operator?.token;
        if (operatorToken) return { token: operatorToken };
        // Fallback: any token
        for (const entry of Object.values(store.tokens) as Array<{ token?: string }>) {
          if (entry?.token) return { token: entry.token };
        }
      }
    }
  } catch {
    /* ignore */
  }

  return {};
}

export function getCronRpcClient(): CronRpcClient {
  if (!client) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    // Read auth from URL query params (like the main control UI) + localStorage fallback
    const urlParams = new URLSearchParams(window.location.search);
    const mainUiAuth = readMainUiAuth();
    const urlToken = urlParams.get("token")?.trim() || undefined;
    const urlPassword = urlParams.get("password")?.trim() || undefined;

    // Token: explicit URL token > main UI stored token
    const token = urlToken || mainUiAuth.token || undefined;
    // Password: URL password (also usable as token fallback for device-skip)
    const password = urlPassword || undefined;

    client = new CronRpcClient(wsUrl, token, password);
  }
  return client;
}
