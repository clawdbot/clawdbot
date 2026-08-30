import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type PhysicalSender = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type EventSender = (method: string, params: unknown) => void;
type PauseKind = "request" | "auth" | "response" | "buffered" | "stream";
type Pause = { nativeId: string; kind: PauseKind; pending?: Promise<unknown> };
type Lease = {
  owner: object;
  prefix: string;
  emit: EventSender;
  pauses: Map<string, Pause>;
  operations: Set<Promise<unknown>>;
  control: Promise<void>;
  acceptEvents: boolean;
};
type FetchState =
  | { kind: "idle" | "gone" }
  | { kind: "owned"; lease: Lease }
  | { kind: "releasing"; lease: Lease; reason: "disable" | "close"; done: Promise<void> }
  | { kind: "uncertain"; lease: Lease; error: unknown }
  | { kind: "retiring"; lease?: Lease };
type OwnedStream = {
  owner: object;
  nativeHandle: string;
  readable: boolean;
  reading: boolean;
  closing?: Promise<unknown>;
};

const STREAM_PREFIX = "openclaw-fetch-stream:";
const REQUEST_COMMANDS = new Set([
  "Fetch.continueRequest",
  "Fetch.continueResponse",
  "Fetch.continueWithAuth",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "Fetch.getResponseBody",
  "Fetch.takeResponseBodyAsStream",
]);

/** One physical Fetch domain; exact logical-session objects own its exclusive lease. */
export class RelayFetch {
  private readonly instanceId = randomUUID();
  private nextLease = 0;
  private nextStream = 0;
  private state: FetchState = { kind: "idle" };
  private readonly streams = new Map<string, OwnedStream>();
  private readonly closedOwners = new WeakSet<object>();
  private retirement?: Promise<{ errors: unknown[] }>;

  // Integration must bind this sender to the exact physical attachment generation,
  // reject stale dispatch, and reject outstanding work when that generation ends.
  constructor(private readonly send: PhysicalSender) {}

  command(
    owner: object,
    emit: EventSender,
    method: string,
    params: unknown,
  ): Promise<unknown> | undefined {
    const input = asOptionalRecord(params);
    const handle = input?.handle;
    const ownedIO =
      (method === "IO.read" || method === "IO.close") &&
      typeof handle === "string" &&
      (handle.startsWith(STREAM_PREFIX) ||
        [...this.streams.values()].some((stream) => stream.nativeHandle === handle));
    if (!method.startsWith("Fetch.") && !ownedIO) {
      return undefined;
    }
    try {
      if (
        this.state.kind === "gone" ||
        this.state.kind === "retiring" ||
        this.closedOwners.has(owner)
      ) {
        throw new Error("Fetch session detached");
      }
      if (ownedIO && typeof handle === "string") {
        return this.streamCommand(owner, method, handle, input);
      }
      if (method === "Fetch.enable") {
        return this.enable(owner, emit, input);
      }
      if (method === "Fetch.disable") {
        if (!("lease" in this.state) || this.state.lease.owner !== owner) {
          return Promise.resolve({});
        }
        return this.release(this.state.lease, "disable").then(() => ({}));
      }
      if (!REQUEST_COMMANDS.has(method)) {
        throw new Error(`Unsupported Fetch command: ${method}`);
      }
      const lease = this.ownedLease(owner);
      const requestId = input?.requestId;
      const nativeId =
        typeof requestId === "string" && requestId.startsWith(lease.prefix)
          ? requestId.slice(lease.prefix.length)
          : undefined;
      const pause = nativeId === undefined ? undefined : lease.pauses.get(nativeId);
      if (!pause) {
        throw new Error("Invalid Fetch requestId for this session");
      }
      this.validatePause(pause, method, input);
      return this.runPause(lease, pause, method, input);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  event(method: string, params: unknown): boolean {
    if (method !== "Fetch.requestPaused" && method !== "Fetch.authRequired") {
      return false;
    }
    const input = asOptionalRecord(params);
    const state = this.state;
    const lease = "lease" in state ? state.lease : undefined;
    if (!lease?.acceptEvents || typeof input?.requestId !== "string") {
      return true;
    }
    const kind =
      method === "Fetch.authRequired"
        ? "auth"
        : input.responseStatusCode !== undefined || input.responseErrorReason !== undefined
          ? "response"
          : "request";
    const nativeId = input.requestId;
    lease.pauses.set(nativeId, { nativeId, kind });
    if (this.state.kind === "owned" && !this.closedOwners.has(lease.owner)) {
      const redirectedRequestId =
        typeof input.redirectedRequestId === "string"
          ? lease.prefix + input.redirectedRequestId
          : undefined;
      lease.emit(method, {
        ...input,
        requestId: lease.prefix + nativeId,
        ...(redirectedRequestId === undefined ? {} : { redirectedRequestId }),
      });
    }
    return true;
  }

  async close(owner: object): Promise<void> {
    this.closedOwners.add(owner);
    const state = this.state;
    if (state.kind === "uncertain" && state.lease.owner === owner) {
      throw state.error;
    }
    const lease = "lease" in state ? state.lease : undefined;
    if (lease?.owner === owner) {
      await this.release(lease, "close");
    }
    const errors = await this.closeStreamSnapshot(
      [...this.streams].filter(([, stream]) => stream.owner === owner),
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Fetch stream cleanup failed");
    }
  }

  /**
   * Stop admission and run bounded best-effort cleanup before the physical owner detaches.
   * Existing hung commands are skipped; transport loss cannot guarantee fail-closed cancellation.
   */
  prepareRetirement(timeoutMs: number): Promise<{ errors: unknown[] }> {
    if (this.retirement) {
      return this.retirement;
    }
    const lease = "lease" in this.state ? this.state.lease : undefined;
    if (lease) {
      this.closedOwners.add(lease.owner);
      lease.acceptEvents = false;
    }
    const pauses = lease ? [...lease.pauses.values()].filter((pause) => !pause.pending) : [];
    lease?.pauses.clear();
    const streams = [...this.streams];
    this.state = { kind: "retiring", ...(lease ? { lease } : {}) };
    this.retirement = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const cleanup = [
        ...pauses.map((pause) => this.sendPauseCleanup(pause)),
        ...streams.map(([handle, stream]) => this.closeStream(handle, stream)),
      ];
      const settled = Promise.all(
        cleanup.map(async (operation) => {
          try {
            await operation;
          } catch (error) {
            errors.push(error);
          }
        }),
      );
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        settled.then(() => false),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
      return {
        errors: [
          ...errors,
          ...(timedOut
            ? [new Error(`Fetch retirement cleanup timed out after ${timeoutMs}ms`)]
            : []),
        ],
      };
    });
    return this.retirement;
  }

  /** Physical loss cannot be canceled through a successor transport. */
  dispose(): void {
    const state = this.state;
    const lease = "lease" in state ? state.lease : undefined;
    if (lease) {
      lease.acceptEvents = false;
      lease.pauses.clear();
    }
    this.streams.clear();
    this.state = { kind: "gone" };
  }

  private ownedLease(owner: object): Lease {
    if (this.state.kind === "uncertain") {
      throw this.state.error;
    }
    if (this.state.kind !== "owned" || this.state.lease.owner !== owner) {
      throw new Error("Fetch interception is owned by another session or is being released");
    }
    return this.state.lease;
  }

  private assertLiveLease(lease: Lease): void {
    if (!("lease" in this.state) || this.state.lease !== lease || this.state.kind === "retiring") {
      throw new Error("Fetch attachment or lease retired");
    }
    if (this.state.kind === "uncertain") {
      throw this.state.error;
    }
  }

  private fence(lease: Lease, error: unknown): void {
    if ("lease" in this.state && this.state.lease === lease && this.state.kind !== "retiring") {
      lease.acceptEvents = false;
      this.state = { kind: "uncertain", lease, error };
    }
  }

  private async nativeFetch(
    lease: Lease,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertLiveLease(lease);
    try {
      const result = await this.send(method, params);
      this.assertLiveLease(lease);
      return result;
    } catch (error) {
      // A protocol error can follow a partial native mutation or post-command access check.
      this.fence(lease, error);
      throw error;
    }
  }

  private enable(
    owner: object,
    emit: EventSender,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.state.kind === "idle") {
      this.state = {
        kind: "owned",
        lease: {
          owner,
          emit,
          prefix: `openclaw-fetch:${this.instanceId}:${++this.nextLease}:`,
          pauses: new Map(),
          operations: new Set(),
          control: Promise.resolve(),
          acceptEvents: true,
        },
      };
    }
    const lease = this.ownedLease(owner);
    const operation = lease.control.then(async () => {
      this.assertLiveLease(lease);
      if (this.state.kind !== "owned") {
        throw new Error("Fetch enable superseded by release");
      }
      const result = await this.nativeFetch(lease, "Fetch.enable", params);
      this.assertLiveLease(lease);
      if (this.state.kind !== "owned" || this.closedOwners.has(owner)) {
        throw new Error("Fetch enable superseded by release");
      }
      return result;
    });
    this.trackOperation(lease, operation);
    lease.control = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private validatePause(pause: Pause, method: string, params?: Record<string, unknown>): void {
    if (pause.pending) {
      throw new Error("Fetch request already has a command in flight");
    }
    const auth = method === "Fetch.continueWithAuth";
    const body = method === "Fetch.getResponseBody" || method === "Fetch.takeResponseBodyAsStream";
    const response = pause.kind === "response" || pause.kind === "buffered";
    if (
      auth !== (pause.kind === "auth") ||
      ((body || method === "Fetch.continueResponse") && !response) ||
      (method === "Fetch.takeResponseBodyAsStream" && pause.kind !== "response") ||
      (pause.kind === "stream" &&
        method !== "Fetch.failRequest" &&
        !(method === "Fetch.fulfillRequest" && typeof params?.body === "string"))
    ) {
      throw new Error(`Invalid Fetch request stage for ${method}`);
    }
  }

  private runPause(
    lease: Lease,
    pause: Pause,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const operation: Promise<unknown> = Promise.resolve().then(async () => {
      this.assertLiveLease(lease);
      if (lease.pauses.get(pause.nativeId) !== pause) {
        throw new Error("Fetch pause retired before command dispatch");
      }
      let result = await this.nativeFetch(lease, method, { ...params, requestId: pause.nativeId });
      this.assertLiveLease(lease);
      if (method === "Fetch.takeResponseBodyAsStream") {
        const response = asOptionalRecord(result);
        if (typeof response?.stream !== "string") {
          const error = new Error("Fetch stream response did not contain a stream handle");
          this.fence(lease, error);
          throw error;
        }
        const handle = `${STREAM_PREFIX}${this.instanceId}:${++this.nextStream}`;
        this.streams.set(handle, {
          owner: lease.owner,
          nativeHandle: response.stream,
          readable: true,
          reading: false,
        });
        result = { ...response, stream: handle };
      }
      if (lease.pauses.get(pause.nativeId) === pause) {
        if (method === "Fetch.getResponseBody") {
          pause.kind = "buffered";
        } else if (method === "Fetch.takeResponseBodyAsStream") {
          pause.kind = "stream";
        } else {
          lease.pauses.delete(pause.nativeId);
        }
      }
      // Only native success proves body acquisition is quiescent. A rejected
      // relay promise leaves this pause pending until physical retirement.
      pause.pending = undefined;
      if (this.closedOwners.has(lease.owner) || this.state.kind === "retiring") {
        throw new Error("Fetch session closed during command");
      }
      return result;
    });
    pause.pending = operation;
    this.trackOperation(lease, operation);
    return operation;
  }

  private trackOperation(lease: Lease, operation: Promise<unknown>): void {
    lease.operations.add(operation);
    void operation
      .finally(() => {
        lease.operations.delete(operation);
      })
      .catch(() => {});
  }

  private release(lease: Lease, reason: "disable" | "close"): Promise<void> {
    this.assertLiveLease(lease);
    if (this.state.kind === "releasing") {
      if (reason === "close") {
        this.state.reason = "close";
      }
      return this.state.done;
    }
    const done = Promise.resolve().then(async () => {
      await lease.control;
      await Promise.allSettled(lease.operations);
      this.assertLiveLease(lease);
      const closeRequested = this.state.kind === "releasing" && this.state.reason === "close";
      if (!closeRequested && [...lease.pauses.values()].some((pause) => pause.kind === "stream")) {
        this.state = { kind: "owned", lease };
        throw new Error(
          "Fetch.disable requires streamed responses to be failed or fulfilled first",
        );
      }
      lease.acceptEvents = false;
      if (closeRequested) {
        const pauses = [...lease.pauses.values()];
        const streams = [...this.streams].filter(([, stream]) => stream.owner === lease.owner);
        lease.pauses.clear();
        // Events racing this bounded snapshot are consumed and dropped. Native disable may resume them.
        const settled = await Promise.allSettled([
          ...pauses.map((pause) => this.sendPauseCleanup(pause)),
          ...streams.map(([handle, stream]) => this.closeStream(handle, stream)),
        ]);
        const errors = settled.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length > 0) {
          const error = new AggregateError(errors, "Fetch owner cleanup failed");
          this.fence(lease, error);
          throw error;
        }
        await this.nativeFetch(lease, "Fetch.disable");
        this.state = { kind: "idle" };
        return;
      }
      await this.nativeFetch(lease, "Fetch.disable");
      lease.pauses.clear();
      this.state = { kind: "idle" };
    });
    this.state = { kind: "releasing", lease, reason, done };
    return done;
  }

  private sendPauseCleanup(pause: Pause): Promise<unknown> {
    return pause.kind === "auth"
      ? this.send("Fetch.continueWithAuth", {
          requestId: pause.nativeId,
          authChallengeResponse: { response: "CancelAuth" },
        })
      : this.send("Fetch.failRequest", { requestId: pause.nativeId, errorReason: "Aborted" });
  }

  private streamCommand(
    owner: object,
    method: string,
    handle: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const stream = this.streams.get(handle);
    if (!stream || stream.owner !== owner || stream.closing) {
      throw new Error("Invalid Fetch stream handle for this session");
    }
    if (method === "IO.close") {
      return this.closeStream(handle, stream);
    }
    if (!stream.readable) {
      throw new Error("Fetch stream is no longer readable");
    }
    if (stream.reading) {
      throw new Error("Fetch stream already has a read in flight");
    }
    stream.reading = true;
    return this.send(method, { ...params, handle: stream.nativeHandle })
      .then((result) => {
        if (this.streams.get(handle) !== stream || this.closedOwners.has(owner)) {
          throw new Error("Fetch stream retired during read");
        }
        return result;
      })
      .catch((error: unknown) => {
        // A relay error may follow a native read that already advanced the cursor.
        stream.readable = false;
        throw error;
      })
      .finally(() => {
        stream.reading = false;
      });
  }

  private closeStream(handle: string, stream: OwnedStream): Promise<unknown> {
    // Native IO.close removes the handle from its IO context. Only confirmed
    // success releases the raw-handle claim; uncertain closes stay fenced until detach.
    stream.readable = false;
    return (stream.closing ??= this.send("IO.close", { handle: stream.nativeHandle }).then(
      (result) => {
        this.streams.delete(handle);
        return result;
      },
    ));
  }

  private async closeStreamSnapshot(streams: Array<[string, OwnedStream]>): Promise<unknown[]> {
    const results = await Promise.allSettled(
      streams.map(([handle, stream]) => this.closeStream(handle, stream)),
    );
    return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  }
}
