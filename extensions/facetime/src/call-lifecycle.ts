type FaceTimeCarrierMode = "ringing" | "muted" | "active" | "closing" | "closed";

type FaceTimeModelMediaMode = "starting" | "ready" | "active" | "suspended" | "closed";

type FaceTimeCallPhase = "ringing" | "answering" | "active" | "closing" | "closed";

type FaceTimeCallIdentity = {
  canonical: string;
  aliases: ReadonlySet<string>;
};

function normalizeCallIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export class FaceTimeCallInstance {
  readonly lifecycleAbort = new AbortController();
  readonly aliases = new Set<string>();
  generation = 1;
  phase: FaceTimeCallPhase;
  carrierMode: FaceTimeCarrierMode;
  modelMediaMode: FaceTimeModelMediaMode = "starting";
  #commandTail: Promise<void> = Promise.resolve();

  constructor(
    readonly canonicalId: string,
    phase: "ringing" | "active",
  ) {
    this.phase = phase;
    this.carrierMode = phase === "ringing" ? "ringing" : "muted";
    this.aliases.add(normalizeCallIdentity(canonicalId));
  }

  get identity(): FaceTimeCallIdentity {
    return { canonical: this.canonicalId, aliases: this.aliases };
  }

  captureGeneration(): number {
    return this.generation;
  }

  assertCurrent(generation: number, allowClosing = false): void {
    const phaseAllowed = allowClosing
      ? this.phase !== "closed"
      : this.phase !== "closing" && this.phase !== "closed";
    if (
      generation !== this.generation ||
      !phaseAllowed ||
      (!allowClosing && this.lifecycleAbort.signal.aborted)
    ) {
      throw new Error("FaceTime call lifecycle changed during carrier command");
    }
  }

  async runCarrierCommand<T>(params: {
    generation: number;
    allowClosing?: boolean;
    action: () => Promise<T>;
  }): Promise<T> {
    const previous = this.#commandTail;
    let release = () => {};
    this.#commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertCurrent(params.generation, params.allowClosing);
      const result = await params.action();
      this.assertCurrent(params.generation, params.allowClosing);
      return result;
    } finally {
      release();
    }
  }

  beginAnswering(): number {
    if (this.phase !== "ringing") {
      throw new Error(`cannot answer FaceTime call in ${this.phase} phase`);
    }
    this.phase = "answering";
    this.carrierMode = "muted";
    return this.generation;
  }

  markCarrierActive(generation: number): void {
    this.assertCurrent(generation);
    this.phase = "active";
    this.carrierMode = "active";
  }

  markModelReady(generation: number): void {
    this.assertCurrent(generation);
    this.modelMediaMode = "ready";
  }

  markModelActive(generation: number): void {
    this.assertCurrent(generation);
    this.modelMediaMode = "active";
  }

  suspendModelMedia(): void {
    if (this.modelMediaMode !== "closed") {
      this.modelMediaMode = "suspended";
    }
  }

  beginClosing(): number {
    if (this.phase === "closed") {
      return this.generation;
    }
    if (this.phase !== "closing") {
      this.generation += 1;
      this.phase = "closing";
      this.carrierMode = "closing";
      this.suspendModelMedia();
      this.lifecycleAbort.abort(new Error("FaceTime call is closing"));
    }
    return this.generation;
  }

  markClosed(): void {
    this.phase = "closed";
    this.carrierMode = "closed";
    this.modelMediaMode = "closed";
  }
}

export class FaceTimeCallRegistry<T extends FaceTimeCallInstance> {
  #active: T | undefined;
  readonly #aliases = new Map<string, T>();

  get active(): T | undefined {
    return this.#active;
  }

  get size(): number {
    return this.#active && this.#active.phase !== "closed" ? 1 : 0;
  }

  values(): IterableIterator<T> {
    return (this.#active && this.#active.phase !== "closed" ? [this.#active] : [])[
      Symbol.iterator
    ]();
  }

  get(identity: string): T | undefined {
    return this.resolve(identity);
  }

  has(identity: string): boolean {
    return this.resolve(identity) !== undefined;
  }

  create(call: T): void {
    if (this.#active && this.#active.phase !== "closed") {
      throw new Error("another FaceTime call lifecycle is already active");
    }
    this.#active = call;
    for (const alias of call.aliases) {
      this.#aliases.set(alias, call);
    }
  }

  resolve(identity: string): T | undefined {
    return this.#aliases.get(normalizeCallIdentity(identity));
  }

  retainAlias(call: T, identity: string): void {
    if (this.#active !== call || call.phase === "closed") {
      throw new Error("cannot retain an alias for an inactive FaceTime call");
    }
    const alias = normalizeCallIdentity(identity);
    const existing = this.#aliases.get(alias);
    if (existing && existing !== call) {
      throw new Error("FaceTime call alias already belongs to another lifecycle");
    }
    call.aliases.add(alias);
    this.#aliases.set(alias, call);
  }

  close(call: T): void {
    if (this.#active !== call) {
      return;
    }
    call.markClosed();
    for (const alias of call.aliases) {
      if (this.#aliases.get(alias) === call) {
        this.#aliases.delete(alias);
      }
    }
    this.#active = undefined;
  }
}
