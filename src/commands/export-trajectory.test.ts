import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { exportTrajectoryCommand } from "./export-trajectory.js";

const mocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn(),
  resolveDefaultSessionStorePath: vi.fn(),
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
}));

vi.mock("../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveDefaultSessionStorePath: mocks.resolveDefaultSessionStorePath,
  };
});

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("exportTrajectoryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDefaultSessionStorePath.mockReturnValue("/tmp/openclaw/sessions.json");
    mocks.loadSessionStore.mockReturnValue({});
  });

  it("points missing session key users at the sessions command", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--session-key is required. Run openclaw sessions to choose a session.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("points missing session users at the sessions command", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
