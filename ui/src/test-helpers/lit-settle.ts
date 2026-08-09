type UpdatingElement = { updateComplete: Promise<boolean> };

// Settling a Lit tree needs two things that a fixed number of awaits only approximates:
// pending promise chains (a route loader, a provider fetch) must get microtask turns to
// resolve, and Lit resolves `updateComplete` to false when that update scheduled another.
// A fixed pump returns while work remains, and a test that then asserts on a timer armed
// by the missing cycle becomes order-dependent: the timer is armed inside the following
// advanceTimersByTime window instead of at mount, so an exact deadline assertion misses.
//
// Loop instead until a whole round changes nothing: two consecutive settled updates with a
// microtask turn between them means no chain resolved into a new render.
//
// A settled update alone is not quiescence: it only says that render did not reschedule
// itself, so a promise chain that calls requestUpdate() at its end can still be in flight.
// Keep an unconditional floor of turns for those, and treat the settled check as the part
// that extends past it, so this drains at least as far as any fixed pump and further when
// the work needs it.
//
// Bounded on purpose, and not a proof of quiescence: a chain deeper than MAX_UPDATE_CYCLES
// microtask turns that only marks the element dirty at its end can still outlive this. A
// macrotask yield would drain any depth, but callers here run on fake timers where one
// never fires. When a test asserts on work of unknown depth, wait for the condition with
// vi.waitFor/expect.poll rather than reaching for a bigger settle.
const MIN_DRAIN_ROUNDS = 5;
const MAX_UPDATE_CYCLES = 50;
const SETTLED_ROUNDS_REQUIRED = 2;

export async function settleLitElement(element: UpdatingElement): Promise<void> {
  let settledRounds = 0;
  for (let cycle = 1; cycle <= MAX_UPDATE_CYCLES; cycle += 1) {
    await Promise.resolve();
    settledRounds = (await element.updateComplete) ? settledRounds + 1 : 0;
    if (cycle >= MIN_DRAIN_ROUNDS && settledRounds >= SETTLED_ROUNDS_REQUIRED) {
      return;
    }
  }
  throw new Error(
    `Lit element still scheduling updates after ${MAX_UPDATE_CYCLES} cycles; it is likely in a render loop.`,
  );
}

export async function settleLitElements(elements: Iterable<UpdatingElement>): Promise<void> {
  for (const element of elements) {
    await settleLitElement(element);
  }
}
