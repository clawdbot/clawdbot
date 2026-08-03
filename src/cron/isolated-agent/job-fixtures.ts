/** Shared loose cron fixtures for isolated-agent tests. */
type LooseRecord = Record<string, unknown>;

/** Builds a loose cron job fixture for isolated-agent unit tests. */
export function makeIsolatedAgentJobFixture(overrides?: LooseRecord) {
  return {
    id: "test-job",
    name: "Test Job",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...overrides,
  } as never;
}

export function makeIsolatedAgentParamsFixture(overrides?: LooseRecord) {
  // Keep the fixture deliberately loose so tests can pass partial CronJob shapes
  // without repeating unrelated scheduler defaults.
  const jobOverrides =
    overrides && "job" in overrides ? (overrides.job as LooseRecord | undefined) : undefined;
  return {
    cfg: {},
    deps: {} as never,
    job: makeIsolatedAgentJobFixture(jobOverrides),
    message: "test",
    sessionKey: "cron:test",
    ...overrides,
  };
}
