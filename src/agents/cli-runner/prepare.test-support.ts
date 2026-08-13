import "./prepare.js";

type CliRunnerPrepareTestApi = {
  resetCliRunnerPrepareTestDeps(): void;
  setCliRunnerPrepareTestDeps(overrides: Record<string, unknown>): void;
};

function getTestApi(): CliRunnerPrepareTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliRunnerPrepareTestApi")
  ] as CliRunnerPrepareTestApi;
}

export function setCliRunnerPrepareTestDeps(overrides: Record<string, unknown>): void {
  getTestApi().setCliRunnerPrepareTestDeps(overrides);
}

export function resetCliRunnerPrepareTestDeps(): void {
  getTestApi().resetCliRunnerPrepareTestDeps();
}
