import { afterEach, expect, it, vi } from "vitest";

const { probeClaudeCliAuthStatus } = vi.hoisted(() => ({
  probeClaudeCliAuthStatus: vi.fn(),
}));
vi.mock("./cli-auth-seam.js", () => ({ probeClaudeCliAuthStatus }));

import provider from "./provider-discovery.js";

afterEach(() => {
  vi.useRealTimers();
  probeClaudeCliAuthStatus.mockReset();
});

it("prepares native availability once for a 632-workspace roster", async () => {
  vi.useFakeTimers();
  const config = {
    agents: {
      entries: Object.fromEntries(
        Array.from({ length: 632 }, (_, index) => [
          `agent-${index}`,
          { workspace: `/synthetic/workspace-${index}` },
        ]),
      ),
    },
  };
  const env = { CLAUDE_CONFIG_DIR: "/synthetic/native-account" };
  probeClaudeCliAuthStatus.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ status: "missing" }), 250);
      }),
  );
  const prepared = new Set<string>();
  const publication = (async () => {
    for (const agentId of Object.keys(config.agents.entries)) {
      await provider.prepareSyntheticAuth!({ config, env, provider: "claude-cli" });
      prepared.add(agentId);
    }
  })();
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(prepared.size).toBe(632);
    expect(probeClaudeCliAuthStatus).toHaveBeenCalledOnce();
  } finally {
    await vi.runAllTimersAsync();
    await publication;
  }
});

it.each(["config", "environment", "capture signal"])(
  "reobserves native availability after a changed %s",
  async (changed) => {
    const config = {};
    const env = {};
    const signal = new AbortController().signal;
    const input = { config, env, signal, provider: "claude-cli" };
    probeClaudeCliAuthStatus
      .mockResolvedValueOnce({ status: "available" })
      .mockResolvedValueOnce({ status: "missing" });
    expect(await provider.prepareSyntheticAuth!(input)).toMatchObject({ mode: "oauth" });
    expect(
      await provider.prepareSyntheticAuth!({
        ...input,
        ...(changed === "config" ? { config: {} } : {}),
        ...(changed === "environment" ? { env: {} } : {}),
        ...(changed === "capture signal" ? { signal: new AbortController().signal } : {}),
      }),
    ).toBeUndefined();
    expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
  },
);

it("joins one probe per cancellation scope and preserves a surviving capture", async () => {
  const config = {};
  const env = {};
  const cancelled = new AbortController();
  const surviving = new AbortController();
  const reason = new Error("native preparation retired");
  let releaseSurvivor: (() => void) | undefined;
  probeClaudeCliAuthStatus
    .mockResolvedValue({ status: "available" })
    .mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(reason), { once: true });
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSurvivor = () => resolve({ status: "available" });
        }),
    );
  const prepare = (signal: AbortSignal) =>
    provider.prepareSyntheticAuth!({ config, env, signal, provider: "claude-cli" });
  const retired = prepare(cancelled.signal);
  const rejection = expect(retired).rejects.toBe(reason);
  const survivor = prepare(surviving.signal);
  const follower = prepare(surviving.signal);
  cancelled.abort(reason);
  releaseSurvivor!();
  await rejection;
  await expect(survivor).resolves.toMatchObject({ mode: "oauth" });
  await expect(follower).resolves.toMatchObject({ mode: "oauth" });
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
  await expect(prepare(cancelled.signal)).rejects.toBe(reason);
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
});
