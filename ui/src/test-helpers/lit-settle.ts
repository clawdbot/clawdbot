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
const MAX_UPDATE_CYCLES = 50;
const SETTLED_ROUNDS_REQUIRED = 2;

export async function settleLitElement(element: UpdatingElement): Promise<void> {
  let settledRounds = 0;
  for (let cycle = 0; cycle < MAX_UPDATE_CYCLES; cycle += 1) {
    await Promise.resolve();
    settledRounds = (await element.updateComplete) ? settledRounds + 1 : 0;
    if (settledRounds >= SETTLED_ROUNDS_REQUIRED) {
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
