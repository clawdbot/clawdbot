// Qa Lab tests bound the evidence checkout ref git probe.
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

import { resolveQaEvidenceEnvironment } from "./evidence-environment.js";

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
});

describe("resolveQaEvidenceEnvironment", () => {
  it("bounds the checkout ref git probe with a timeout", () => {
    execFileSyncMock.mockReturnValue("abc123\n");

    const environment = resolveQaEvidenceEnvironment({ env: {} });

    expect(environment.ref).toBe("abc123");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      expect.objectContaining({
        killSignal: "SIGKILL",
        timeout: 5_000,
      }),
    );
  });

  it("falls back to GITHUB_SHA when the git probe times out", () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" });
    });

    const environment = resolveQaEvidenceEnvironment({ env: { GITHUB_SHA: "fallbacksha" } });

    expect(environment.ref).toBe("fallbacksha");
  });

  it("prefers OPENCLAW_QA_REF without invoking git", () => {
    const environment = resolveQaEvidenceEnvironment({
      env: { OPENCLAW_QA_REF: "qa-ref", GITHUB_SHA: "fallbacksha" },
    });

    expect(environment.ref).toBe("qa-ref");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns a null ref when the probe fails and no env fallback exists", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("git unavailable");
    });

    const environment = resolveQaEvidenceEnvironment({ env: {} });

    expect(environment.ref).toBeNull();
  });
});
