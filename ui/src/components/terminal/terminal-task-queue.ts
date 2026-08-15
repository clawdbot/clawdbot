// Terminal boot ownership: serialize open and reattach work so requests that
// arrive during an async boot are delayed instead of silently discarded.
async function runTerminalTaskSteps(
  isCurrent: () => boolean,
  steps: Array<() => Promise<void>>,
): Promise<void> {
  for (const step of steps) {
    await step();
    if (!isCurrent()) {
      return;
    }
  }
}

export class TerminalTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  enqueue(task: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;
    const run = () => (isCurrent() ? task(isCurrent) : Promise.resolve());
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }

  enqueueSteps(...steps: Array<() => Promise<void>>): Promise<void> {
    return this.enqueue((isCurrent) => runTerminalTaskSteps(isCurrent, steps));
  }

  reset(): void {
    this.generation += 1;
  }
}
