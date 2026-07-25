import { randomUUID } from "node:crypto";
import net from "node:net";

// A2UI may stop a load, wait up to 6 seconds for the renderer, then evaluate.
// Keep the outer IPC deadline above the app's complete 22-second phase budget.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

type LinuxCanvasActionEvent = {
  event: "a2ui-action";
  id: string;
  action: unknown;
};

type LinuxCanvasIpcRequestHooks = {
  /** Called synchronously when this FIFO request is about to reach the app. */
  onDispatch?(): void;
};

type PendingRequest = {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type LinuxCanvasIpcTransport = {
  request(command: string, paramsJSON: string, hooks?: LinuxCanvasIpcRequestHooks): Promise<string>;
  setActionHandler(handler: (event: LinuxCanvasActionEvent) => Promise<void>): void;
  sendActionResult(id: string, result: { ok: boolean; error?: string }): void;
  close(): void;
};

function canvasUnavailable(message = "desktop app not running"): Error {
  return new Error(`CANVAS_UNAVAILABLE: ${message}`);
}

function parseFrame(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class LinuxCanvasIpcClient implements LinuxCanvasIpcTransport {
  private socket: net.Socket | undefined;
  private connecting: Promise<net.Socket> | undefined;
  private connectingSocket: net.Socket | undefined;
  private closed = false;
  private buffer = "";
  private bufferBytes = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private actionHandler: ((event: LinuxCanvasActionEvent) => Promise<void>) | undefined;
  private requestTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  setActionHandler(handler: (event: LinuxCanvasActionEvent) => Promise<void>): void {
    this.actionHandler = handler;
  }

  request(
    command: string,
    paramsJSON: string,
    hooks?: LinuxCanvasIpcRequestHooks,
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(canvasUnavailable("node host is shutting down"));
    }
    const request = this.requestTail.then(
      () => this.sendRequest(command, paramsJSON, hooks),
      () => this.sendRequest(command, paramsJSON, hooks),
    );
    this.requestTail = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  private async sendRequest(
    command: string,
    paramsJSON: string,
    hooks?: LinuxCanvasIpcRequestHooks,
  ): Promise<string> {
    if (this.closed) {
      throw canvasUnavailable("node host is shutting down");
    }
    const socket = await this.connect();
    if (this.closed) {
      throw canvasUnavailable("node host is shutting down");
    }
    const id = randomUUID();
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CANVAS_UNAVAILABLE: desktop app timed out handling ${command}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      hooks?.onDispatch?.();
      socket.write(`${JSON.stringify({ id, command, paramsJSON })}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(canvasUnavailable());
      });
    });
  }

  sendActionResult(id: string, result: { ok: boolean; error?: string }): void {
    this.socket?.write(`${JSON.stringify({ event: "a2ui-action-result", id, ...result })}\n`);
  }

  close(): void {
    this.closed = true;
    this.connectingSocket?.destroy();
    this.socket?.destroy();
    this.reset(canvasUnavailable("node host is shutting down"));
  }

  private async connect(): Promise<net.Socket> {
    if (this.closed) {
      throw canvasUnavailable("node host is shutting down");
    }
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    this.connecting ??= new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      this.connectingSocket = socket;
      const fail = () => {
        socket.destroy();
        reject(this.closed ? canvasUnavailable("node host is shutting down") : canvasUnavailable());
      };
      socket.once("error", fail);
      socket.once("close", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        socket.off("close", fail);
        if (this.closed) {
          socket.destroy();
          reject(canvasUnavailable("node host is shutting down"));
          return;
        }
        socket.setEncoding("utf8");
        socket.on("error", () => this.resetSocket(socket, canvasUnavailable()));
        socket.on("close", () => this.resetSocket(socket, canvasUnavailable()));
        socket.on("data", (chunk) =>
          this.onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
        );
        this.socket = socket;
        resolve(socket);
      });
    }).finally(() => {
      this.connecting = undefined;
      this.connectingSocket = undefined;
    });
    return await this.connecting;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk, "utf8");
    if (this.bufferBytes > MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.socket?.destroy(new Error("canvas IPC frame exceeded 32 MiB"));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.bufferBytes = Buffer.byteLength(this.buffer, "utf8");
      if (line) {
        if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
          this.socket?.destroy(new Error("canvas IPC frame exceeded 32 MiB"));
          return;
        }
        const frame = parseFrame(line);
        if (frame === undefined) {
          this.socket?.destroy(new Error("desktop app sent invalid canvas IPC JSON"));
          return;
        }
        this.onFrame(frame);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private onFrame(frame: unknown): void {
    if (!isRecord(frame)) {
      return;
    }
    if (frame.event === "a2ui-action" && typeof frame.id === "string") {
      const event: LinuxCanvasActionEvent = {
        event: "a2ui-action",
        id: frame.id,
        action: frame.action,
      };
      void this.actionHandler?.(event).catch(() => {});
      return;
    }
    if (typeof frame.id !== "string") {
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok === true) {
      if (typeof frame.payloadJSON !== "string") {
        pending.reject(canvasUnavailable("desktop app returned an invalid payload"));
        return;
      }
      try {
        JSON.parse(frame.payloadJSON);
      } catch {
        pending.reject(canvasUnavailable("desktop app returned invalid payload JSON"));
        return;
      }
      pending.resolve(frame.payloadJSON);
      return;
    }
    const error = isRecord(frame.error) ? frame.error : undefined;
    const code = typeof error?.code === "string" ? error.code : "CANVAS_UNAVAILABLE";
    const message = typeof error?.message === "string" ? error.message : "desktop app failed";
    pending.reject(new Error(`${code}: ${message}`));
  }

  private resetSocket(socket: net.Socket, error: Error): void {
    if (this.socket === socket) {
      this.reset(error);
    }
  }

  private reset(error: Error): void {
    this.socket = undefined;
    this.buffer = "";
    this.bufferBytes = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
