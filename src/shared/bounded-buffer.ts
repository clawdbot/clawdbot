type BoundedBufferOverflow<T> =
  | { mode: "latch" }
  | { mode: "drop-oldest"; fit?: (value: T, capacity: number) => T }
  | { mode: "fail-closed"; onOverflow: () => void };

export class BoundedBuffer<T> {
  protected values: T[] = [];
  private size = 0;
  private closed = false;

  constructor(
    private readonly capacity: number,
    private readonly overflow: BoundedBufferOverflow<T>,
    private readonly measure: (value: T) => number = () => 1,
  ) {}

  push(value: T): boolean {
    if (this.closed) {
      return false;
    }
    const valueSize = this.measure(value);
    if (this.size + valueSize <= this.capacity) {
      this.values.push(value);
      this.size += valueSize;
      return true;
    }
    if (this.overflow.mode !== "drop-oldest") {
      this.closed = true;
      if (this.overflow.mode === "fail-closed") {
        this.drain();
        this.overflow.onOverflow();
      }
      return false;
    }
    this.values.push(value);
    this.size += valueSize;
    let dropped = 0;
    // Leave the newest value for fitting; preserve the > comparison for NaN capacities.
    for (const oldest of this.values) {
      if (!(this.size > this.capacity) || dropped === this.values.length - 1) {
        break;
      }
      this.size -= this.measure(oldest);
      dropped += 1;
    }
    this.values.splice(0, dropped);
    if (this.size > this.capacity) {
      const fitted = this.overflow.fit?.(value, this.capacity);
      this.values = fitted === undefined ? [] : [fitted];
      this.size = fitted === undefined ? 0 : this.measure(fitted);
    }
    return true;
  }

  drain(): T[] {
    const values = this.values;
    this.values = [];
    this.size = 0;
    return values;
  }
}
