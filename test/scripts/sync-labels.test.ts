import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

describe("sync-labels", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((command: string, args?: readonly string[]) => {
      if (command === "git") {
        return "https://github.com/openclaw/openclaw.git\n";
      }
      if (command === "gh" && args?.some((arg) => arg.includes("/labels?"))) {
        return "[]";
      }
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds every GitHub CLI operation", async () => {
    await import("../../scripts/sync-labels.ts");

    const ghCalls = execFileSyncMock.mock.calls.filter(([command]) => command === "gh");
    expect(ghCalls.length).toBeGreaterThan(1);
    for (const [, , options] of ghCalls) {
      expect(options).toMatchObject({
        timeout: 120_000,
        killSignal: "SIGKILL",
      });
    }
  });
});
