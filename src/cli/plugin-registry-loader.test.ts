// Plugin registry loader tests cover CLI plugin registry loading and cache reset behavior.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";

const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const readRegistryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ entries: Array<{ backendId?: string }> }> => ({ entries: [] })),
);
const tempDirs = createTempDirTracker();

vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("../agents/sandbox/registry.js", () => ({
  readRegistry: readRegistryMock,
}));

describe("plugin-registry-loader", () => {
  let originalForceStderr: boolean;
  let ensureCliPluginRegistryLoaded: typeof import("./plugin-registry-loader.js").ensureCliPluginRegistryLoaded;
  let loggingState: typeof import("../logging/state.js").loggingState;

  beforeAll(async () => {
    ({ ensureCliPluginRegistryLoaded } = await import("./plugin-registry-loader.js"));
    ({ loggingState } = await import("../logging/state.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    readRegistryMock.mockResolvedValue({ entries: [] });
    originalForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
  });

  afterEach(() => {
    flushDiagnosticsTimeline();
    tempDirs.cleanup();
    loggingState.forceConsoleToStderr = originalForceStderr;
    vi.unstubAllEnvs();
  });

  it("routes plugin load logs to stderr and restores state", async () => {
    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      routeLogsToStderr: true,
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
    expect(captured).toEqual([true]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("keeps stdout routing unchanged when stderr routing is not requested", async () => {
    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await ensureCliPluginRegistryLoaded({
      scope: "all",
    });

    expect(captured).toEqual([false]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("forwards explicit config snapshots to plugin loading", async () => {
    const config = { channels: { quietchat: { enabled: true } } } as never;
    const activationSourceConfig = { channels: { quietchat: { enabled: true } } } as never;

    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      config,
      activationSourceConfig,
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      config,
      activationSourceConfig,
    });
  });

  it("forwards configured-channel load scope without startup dependency repair", async () => {
    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
  });

  it("includes persisted runtime owners when loading sandbox managers", async () => {
    readRegistryMock.mockResolvedValue({
      entries: [{ backendId: "openshell" }, { backendId: "docker" }, { backendId: "openshell" }],
    });

    await ensureCliPluginRegistryLoaded({ scope: "sandbox-management" });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "sandbox-backends",
      persistedSandboxBackendIds: ["docker", "openshell"],
    });
  });

  it("attributes module import separately from runtime loading", async () => {
    const dir = tempDirs.make("openclaw-plugin-registry-startup-");
    const timelinePath = join(dir, "timeline.jsonl");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "timeline");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);

    await measureCliCommandStartup("plugin-registry", () =>
      ensureCliPluginRegistryLoaded({
        scope: "all",
      }),
    );

    flushDiagnosticsTimeline();
    const events = (await readFile(timelinePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const starts = events.filter((event) => event.type === "span.start");
    const outer = starts.find(
      (event) => (event.attributes as { stage?: string } | undefined)?.stage === "plugin-registry",
    );
    expect(outer).toBeDefined();
    expect(
      starts
        .filter((event) => event.parentSpanId === outer?.spanId)
        .map((event) => (event.attributes as { stage?: string } | undefined)?.stage),
    ).toEqual(["plugin-registry-module-import", "plugin-registry-runtime-load"]);
  });
});
