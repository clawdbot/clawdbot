import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { startSessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import { sessionLog } from "./sessions-shared.js";

let previousDiagnostics: boolean;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
});
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

test("disabled patch diagnostics do not start clocks or record work", () => {
  setDiagnosticsEnabledForProcess(false);
  const clock = vi.spyOn(performance, "now");
  const log = vi.spyOn(sessionLog, "info");
  expect(startSessionPatchDiagnostics("sessions.patch")).toBeUndefined();
  expect(clock).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test("parallel and repeated phases retain separate elapsed contributions and bounded fields", () => {
  setDiagnosticsEnabledForProcess(true);
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
  const diagnostics = expectDefined(
    startSessionPatchDiagnostics("sessions.patchMany"),
    "enabled bulk patch diagnostics",
  );
  const first = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  const second = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  clock = 600;
  second.finish();
  clock = 1_400;
  first.finish();
  const group = expectDefined(diagnostics.scope("snapshot"), "active snapshot phase");
  clock = 1_500;
  group.mark("projection");
  clock = 1_600;
  group.mark("snapshot");
  clock = 1_800;
  group.finish();
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith("slow session patch", {
    method: "sessions.patchMany",
    elapsedMs: 1_800,
    phaseDurationsMs: { snapshot: 300, projection: 100, catalog: 2_000 },
    phaseCounts: { snapshot: 2, projection: 1, catalog: 2 },
  });
});

test("request settlement closes unfinished phases and retires retained markers", () => {
  setDiagnosticsEnabledForProcess(true);
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
  const diagnostics = expectDefined(
    startSessionPatchDiagnostics("sessions.patch"),
    "enabled patch diagnostics",
  );
  const scope = expectDefined(diagnostics.scope("preflight"), "active preflight phase");
  clock = 1_500;
  diagnostics.finish();
  clock = 3_000;
  scope.mark("catalog");
  scope.finish();
  expect(diagnostics.scope("effects")).toBeUndefined();
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith("slow session patch", {
    method: "sessions.patch",
    elapsedMs: 1_500,
    phaseDurationsMs: { preflight: 1_500 },
    phaseCounts: { preflight: 1 },
  });
});

test("a failed diagnostic sink cannot replace the operation error", () => {
  setDiagnosticsEnabledForProcess(true);
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(sessionLog, "info").mockImplementation(() => {
    throw new Error("synthetic diagnostic sink failure");
  });
  const originalError = new Error("synthetic operation failure");
  const operation = () => {
    const diagnostics = expectDefined(
      startSessionPatchDiagnostics("sessions.patch"),
      "enabled patch diagnostics",
    );
    diagnostics.scope("preflight");
    try {
      clock = 1_500;
      throw originalError;
    } finally {
      diagnostics.finish();
    }
  };
  expect(operation).toThrow(originalError);
});

test("disabling diagnostics retires an in-flight observation without publishing it later", () => {
  setDiagnosticsEnabledForProcess(true);
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
  const diagnostics = expectDefined(
    startSessionPatchDiagnostics("sessions.patch"),
    "enabled patch diagnostics",
  );
  const scope = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  clock = 2_000;
  setDiagnosticsEnabledForProcess(false);
  diagnostics.finish();
  setDiagnosticsEnabledForProcess(true);
  scope.finish();
  diagnostics.finish();
  expect(log).not.toHaveBeenCalled();
});
