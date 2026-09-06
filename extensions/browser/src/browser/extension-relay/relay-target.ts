import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type FilterEntry = { type?: string; exclude?: boolean };
type Interest = { filter: FilterEntry[]; flatten: boolean; admitted: boolean };
const DEFAULT_FILTER: FilterEntry[] = [
  { type: "browser", exclude: true },
  { type: "tab", exclude: true },
  {},
];
const matches = (filter: FilterEntry[], type?: string) => {
  const entry = filter.find((candidate) => candidate.type === undefined || candidate.type === type);
  return entry !== undefined && entry.exclude !== true;
};

/** One native Target policy, projected onto exact logical parent interests. */
export class RelayTarget<Owner extends object> {
  private readonly interests = new Map<Owner, Interest>();
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = false;

  constructor(
    private readonly send: (params: Record<string, unknown>) => Promise<unknown>,
    private readonly reconcile: () => Promise<void>,
    private readonly assertActive: () => void,
  ) {}

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(() => {
      this.assertActive();
      return operation();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  interest(owner: Owner, type: string): Interest | undefined {
    const interest = this.interests.get(owner);
    return interest && matches(interest.filter, type) ? interest : undefined;
  }

  wanted(type: string): boolean {
    return [...this.interests.values()].some((interest) => matches(interest.filter, type));
  }

  private params(): Record<string, unknown> {
    if (!this.interests.size) {
      return { autoAttach: false, waitForDebuggerOnStart: false, flatten: true };
    }
    const filters = [...this.interests.values()].map((interest) => interest.filter);
    const fallback = filters.some((filter) => matches(filter));
    const types = [
      ...new Set(
        filters.flatMap((filter) =>
          filter.flatMap((entry) => (entry.type === undefined ? [] : [entry.type])),
        ),
      ),
    ].toSorted();
    // Chromium uses first match, otherwise exclusion. Keep each logical filter
    // ordered; union only its per-type decision plus the unknown-type default.
    const union: FilterEntry[] = types.flatMap((type) => {
      const include = filters.some((filter) => matches(filter, type));
      return include === fallback ? [] : [{ type, exclude: !include }];
    });
    if (fallback) {
      union.push({});
    }
    return { autoAttach: true, waitForDebuggerOnStart: this.waiting, flatten: true, filter: union };
  }

  command(
    owner: Owner,
    params: Record<string, unknown> | undefined,
    assertCurrent: () => void,
  ): Promise<unknown> {
    if (
      typeof params?.autoAttach !== "boolean" ||
      typeof params.waitForDebuggerOnStart !== "boolean" ||
      (params.flatten !== undefined && typeof params.flatten !== "boolean")
    ) {
      throw new Error("Invalid Target auto-attach parameters");
    }
    let filter = DEFAULT_FILTER;
    if (params.filter !== undefined) {
      if (!Array.isArray(params.filter)) {
        throw new Error("Invalid Target filter");
      }
      filter = params.filter.map((value) => {
        const entry = asOptionalRecord(value);
        if (
          !entry ||
          (entry.type !== undefined && typeof entry.type !== "string") ||
          (entry.exclude !== undefined && typeof entry.exclude !== "boolean")
        ) {
          throw new Error("Invalid Target filter entry");
        }
        return {
          ...(typeof entry.type === "string" ? { type: entry.type } : {}),
          ...(typeof entry.exclude === "boolean" ? { exclude: entry.exclude } : {}),
        };
      });
    }
    if (!params.autoAttach && params.filter !== undefined && filter.length) {
      throw new Error("Target filter should be empty when disabling auto-attach");
    }
    const waiting = params.waitForDebuggerOnStart;
    const next = params.autoAttach
      ? { filter, flatten: params.flatten === true, admitted: false }
      : undefined;
    return this.enqueue(async () => {
      assertCurrent();
      if (next) {
        this.interests.set(owner, next);
      } else {
        this.interests.delete(owner);
      }
      // Wait policy remains native/shared last-update behavior, including DevTools suspend.
      this.waiting = waiting;
      try {
        await this.reconcile();
        const result = await this.send(this.params());
        assertCurrent();
        if (next && this.interests.get(owner) === next) {
          next.admitted = true;
        }
        await this.reconcile();
        return result;
      } catch (error) {
        if (this.interests.get(owner) === next) {
          this.interests.delete(owner);
        }
        throw error;
      }
    });
  }

  remove(owner: Owner): Promise<void> | undefined {
    if (!this.interests.delete(owner)) {
      return undefined;
    }
    return this.enqueue(async () => {
      await this.reconcile();
      await this.send(this.params());
    });
  }

  dispose(): void {
    this.interests.clear();
  }
}
