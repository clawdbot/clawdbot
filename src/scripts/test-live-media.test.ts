import { afterEach, describe, expect, it, vi } from "vitest";

const loadShellEnvFallbackMock = vi.fn();
const collectProviderApiKeysMock = vi.fn((provider: string) =>
  process.env[`TEST_AUTH_${provider.toUpperCase()}`] ? ["test-key"] : [],
);

vi.mock("../../src/infra/shell-env.js", () => ({
  loadShellEnvFallback: loadShellEnvFallbackMock,
}));

vi.mock("../../src/agents/live-auth-keys.js", () => ({
  collectProviderApiKeys: collectProviderApiKeysMock,
}));

function requirePlanEntry(
  plan: ReturnType<typeof import("../../scripts/test-live-media.ts").buildRunPlan>,
  suiteId: string,
) {
  const entry = plan.find((candidate) => candidate.suite.id === suiteId);
  if (!entry) {
    throw new Error(`expected ${suiteId} run plan entry`);
  }
  return entry;
}

describe("test-live-media", () => {
  afterEach(() => {
    collectProviderApiKeysMock.mockClear();
    loadShellEnvFallbackMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("defaults to all suites with auth filtering", async () => {
    vi.stubEnv("TEST_AUTH_OPENAI", "1");
    vi.stubEnv("TEST_AUTH_GOOGLE", "1");
    vi.stubEnv("TEST_AUTH_MINIMAX", "1");
    vi.stubEnv("TEST_AUTH_FAL", "1");
    vi.stubEnv("TEST_AUTH_VYDRA", "1");

    const { buildRunPlan, parseArgs } = await import("../../scripts/test-live-media.ts");
    const plan = buildRunPlan(parseArgs([]));

    expect(plan.map((entry) => entry.suite.id)).toEqual(["image", "music", "video"]);
    expect(requirePlanEntry(plan, "image").providers).toEqual([
      "fal",
      "google",
      "minimax",
      "openai",
      "vydra",
    ]);
    expect(requirePlanEntry(plan, "music").providers).toEqual(["google", "minimax"]);
    expect(requirePlanEntry(plan, "video").providers).toEqual([
      "google",
      "minimax",
      "openai",
      "vydra",
    ]);
  });

  it("supports suite-specific provider filters without auth narrowing", async () => {
    const { buildRunPlan, parseArgs } = await import("../../scripts/test-live-media.ts");
    const plan = buildRunPlan(
      parseArgs(["video", "--video-providers", "fal,openai,runway", "--all-providers"]),
    );

    expect(plan).toHaveLength(1);
    const [entry] = plan;
    expect(entry?.suite.id).toBe("video");
    expect(entry?.providers).toEqual(["fal", "openai", "runway"]);
  });

  it("forwards quiet flags separately from passthrough args", async () => {
    const { parseArgs } = await import("../../scripts/test-live-media.ts");
    const options = parseArgs(["image", "--quiet", "--reporter", "dot"]);

    expect(options.suites).toEqual(["image"]);
    expect(options.quietArgs).toEqual(["--quiet"]);
    expect(options.passthroughArgs).toEqual(["--reporter", "dot"]);
  });
});
