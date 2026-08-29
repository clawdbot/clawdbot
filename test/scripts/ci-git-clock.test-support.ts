export function renderGitTestClock(
  source: string,
  options: { realClock?: boolean; realDrain?: boolean } = {},
) {
  if (options.realClock) {
    return source;
  }
  // Only a ready, deliberately stalled tree advances the fetch clock. Real
  // process startup and teardown retain their independent wall-clock watchdogs.
  const rendered = source
    .replace(/fetch_timeout_seconds = [^\n]+/u, "fetch_timeout_seconds = 2")
    .replace(
      "def run_git(",
      `def fetch_clock():
    return 2 * sum(name.startswith("fetch-tick-") and name.endswith(".json")
                   for name in os.listdir(os.environ["TMPDIR"]))


def run_git(`,
    )
    .replace("deadline = time.monotonic() + timeout", "deadline = fetch_clock() + timeout")
    .replace(
      "deadline is not None and time.monotonic() >= deadline",
      "deadline is not None and fetch_clock() >= deadline",
    )
    .replace("timeout=30)", "timeout=2)")
    .replace(/retry_at = time\.monotonic\(\) \+ [^\n]+/u, "retry_at = time.monotonic() + 0.05")
    .replaceAll("--git 120", "--git 2")
    // Keep pre-fix standalone shell bodies executable for red/green proof.
    .replaceAll("120s git", "2s git")
    .replaceAll("sleep $((attempt * 5))", "sleep 0.05")
    .replaceAll("sleep 5", "sleep 0.05");
  return options.realDrain
    ? rendered
    : rendered.replace("kill_at = deadline - cleanup_seconds / 2", "kill_at = time.monotonic()");
}
