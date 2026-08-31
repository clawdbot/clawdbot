// Process-lifetime wait primitive for CLI paths that intentionally never return.
export function waitForever() {
  // Keep the event loop alive with a ref'd interval. A pending Promise is not
  // an active handle on its own, so without the interval, Node exits the
  // process with code 13 ("unsettled top-level await") as soon as nothing
  // else is keeping the loop open — defeating the "wait forever" contract.
  // The handle is intentionally not retained: there is no caller-visible way
  // to stop a "forever" wait, and the interval lives for the lifetime of the
  // process.
  setInterval(() => {}, 1_000_000);
  return new Promise<void>(() => {
    /* never resolve */
  });
}
