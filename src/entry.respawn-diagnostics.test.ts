import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  mode: "flags" as "flags" | "compile-cache",
  trace: false,
  events: [] as string[],
  writer: undefined as ((message: string, error?: unknown) => void | Promise<void>) | undefined,
}));

vi.mock("./infra/is-main.js", () => ({ isMainModule: () => true }));
vi.mock("./infra/openclaw-exec-env.js", () => ({ ensureOpenClawExecMarkerOnProcess: vi.fn() }));
vi.mock("./infra/warning-filter.js", () => ({ installProcessWarningFilter: vi.fn() }));
vi.mock("./cli/dotenv.js", () => ({
  loadCliDotEnv: () => boundary.events.push("dotenv"),
}));
vi.mock("./cli/startup-trace.js", () => ({
  createGatewayDispatchStartupTrace: () => ({ enabled: boundary.trace, mark: vi.fn() }),
  configureGatewayStartupTraceConsoleFormatting: async () => {
    boundary.events.push("trace formatting");
  },
}));
vi.mock("./entry.compile-cache.js", () => ({
  resolveEntryInstallRoot: () => "/fixture/openclaw",
  enableOpenClawCompileCache: vi.fn(),
  respawnWithoutOpenClawCompileCacheIfNeeded: async (params: {
    prepareWriteError: () => Promise<NonNullable<typeof boundary.writer>>;
  }) => {
    if (boundary.mode !== "compile-cache") {
      return false;
    }
    boundary.writer = await params.prepareWriteError();
    boundary.events.push("spawn");
    return true;
  },
}));
vi.mock("./entry.respawn.js", () => ({
  buildCliRespawnPlan: () => ({ command: "node", argv: [], env: {} }),
  runCliRespawnPlan: (_plan: unknown, _runtime: unknown, writer: typeof boundary.writer) => {
    boundary.writer = writer;
    boundary.events.push("spawn");
  },
}));

const originalArgv = process.argv;
const originalTitle = process.title;

beforeEach(() => {
  vi.resetModules();
  boundary.events = [];
  boundary.writer = undefined;
  process.argv = [
    process.execPath,
    "/fixture/openclaw/dist/entry.js",
    "plugins",
    "enable",
    "fixture",
  ];
});
afterEach(() => {
  process.argv = originalArgv;
  process.title = originalTitle;
  vi.restoreAllMocks();
});

it.each([
  { mode: "flags", trace: false },
  { mode: "flags", trace: true },
  { mode: "compile-cache", trace: false },
  { mode: "compile-cache", trace: true },
] as const)(
  "prepares $mode diagnostics only when needed (trace: $trace)",
  async ({ mode, trace }) => {
    boundary.mode = mode;
    boundary.trace = trace;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      boundary.events.push("diagnostic");
      return true;
    });

    await import("./entry.js");

    expect(boundary.events).toEqual(trace ? ["dotenv", "trace formatting", "spawn"] : ["spawn"]);
    expect(stderr).not.toHaveBeenCalled();
    expect(boundary.writer).toBeTypeOf("function");
    await boundary.writer?.("startup failed");
    expect(boundary.events).toEqual(
      trace
        ? ["dotenv", "trace formatting", "spawn", "diagnostic"]
        : ["spawn", "dotenv", "trace formatting", "diagnostic"],
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("startup failed"));
  },
);
