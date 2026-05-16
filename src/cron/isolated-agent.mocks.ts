import { vi } from "vitest";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

vi.mock("../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-selection.js")>(
    "../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: vi.fn(() => false),
  };
});

vi.mock("../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("./isolated-agent/run-runtime-plugins.runtime.js", () => ({
  ensureRuntimePluginsLoaded: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

export const makeIsolatedAgentJob = makeIsolatedAgentJobFixture;
export const makeIsolatedAgentParams = makeIsolatedAgentParamsFixture;
