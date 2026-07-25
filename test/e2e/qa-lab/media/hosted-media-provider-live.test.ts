// Hosted media provider live producer tests cover QA evidence wiring.
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_SUITES,
  buildRunPlan,
  buildHostedMediaCommand,
  buildHostedMediaEvidence,
  classifyHostedMediaFailureStatus,
  findSkippedExplicitProviderSelections,
  formatHelp,
  parseArgs,
  parseHostedMediaOptions,
  runCli,
  type SuiteRunPlan,
} from "./hosted-media-provider-live.js";

const SOURCE_PATH = "test/e2e/qa-lab/media/hosted-media-provider-live.ts";
const loadShellEnvFallbackMock = vi.fn();
const collectProviderApiKeysMock = vi.fn((provider: string) =>
  process.env[`TEST_AUTH_${provider.toUpperCase()}`] ? ["test-key"] : [],
);

function requirePlanEntry(plan: SuiteRunPlan[], suiteId: string) {
  const entry = plan.find((candidate) => candidate.suite.id === suiteId);
  if (!entry) {
    throw new Error(`expected ${suiteId} run plan entry`);
  }
  return entry;
}

afterEach(() => {
  collectProviderApiKeysMock.mockClear();
  loadShellEnvFallbackMock.mockReset();
  vi.unstubAllEnvs();
});

describe("hosted media provider live QA producer", () => {
  it("builds the image live media command with provider filters from env", () => {
    const options = parseHostedMediaOptions([
      "--suite",
      "image",
      "--artifact-base",
      ".artifacts/qa-e2e/image",
      "--providers-env",
      "OPENCLAW_QA_HOSTED_MEDIA_PROVIDERS",
    ]);
    const command = buildHostedMediaCommand({
      env: { OPENCLAW_QA_HOSTED_MEDIA_PROVIDERS: "openai,google" },
      options,
    });

    expect(command.args).toContain(SOURCE_PATH);
    expect(command.args).toContain("image");
    expect(command.args).toContain("--image-providers");
    expect(command.args).toContain("openai,google");
    expect(command.env.OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES).toBeUndefined();
  });

  it("forces full video modes so reference image and video inputs are covered", () => {
    const options = parseHostedMediaOptions([
      "--suite",
      "video",
      "--artifact-base",
      ".artifacts/qa-e2e/video",
    ]);
    const command = buildHostedMediaCommand({ env: {}, options });

    expect(command.args).toContain("video");
    expect(command.env.OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES).toBe("1");
  });

  it("classifies missing live media auth as blocked evidence", () => {
    expect(
      classifyHostedMediaFailureStatus(
        "[live:media] no runnable providers matched available auth; pass --allow-empty",
      ),
    ).toBe("blocked");
    expect(classifyHostedMediaFailureStatus("provider response was malformed")).toBe("fail");
  });

  it("leaves video provider coverage mapping to the scenario catalog", () => {
    const artifactBase = path.join(os.tmpdir(), "openclaw-hosted-media-live-test");
    const options = parseHostedMediaOptions(["--suite", "video", "--artifact-base", artifactBase]);
    const evidence = buildHostedMediaEvidence({
      options,
      result: {
        durationMs: 10,
        status: "pass",
      },
    });

    expect(evidence.entries[0]?.coverage).toEqual([]);
  });
});

describe("hosted media provider live CLI", () => {
  it("prints help for the live media command", () => {
    const help = formatHelp();

    expect(help).toContain("Media live harness");
    expect(help).toContain("pnpm test:live:media");
  });

  it("rejects unknown global providers for the selected suites", () => {
    expect(() =>
      parseArgs(["image", "--providers", "definitely-not-a-provider", "--all-providers"]),
    ).toThrow("Unknown provider(s) for selected media suite(s): definitely-not-a-provider");
  });

  it("rejects unknown suite-specific providers", () => {
    expect(() => parseArgs(["image", "--image-providers", "runway", "--all-providers"])).toThrow(
      "Unknown image provider(s): runway",
    );
  });

  it("accepts providers supported by the wrapped live suites", () => {
    expect(
      parseArgs(["image", "--image-providers", "openrouter", "--all-providers"]).suiteProviders
        .image,
    ).toEqual(new Set(["openrouter"]));
    expect(
      parseArgs(["music", "--music-providers", "fal,openrouter", "--all-providers"]).suiteProviders
        .music,
    ).toEqual(new Set(["fal", "openrouter"]));
    expect(
      parseArgs(["video", "--video-providers", "openrouter", "--all-providers"]).suiteProviders
        .video,
    ).toEqual(new Set(["openrouter"]));
  });

  it("rejects suite-specific provider filters for unselected suites", () => {
    expect(() => parseArgs(["image", "--music-providers", "fal", "--all-providers"])).toThrow(
      "Provider filter(s) target unselected media suite(s): music",
    );
  });

  it("passes single-dash Vitest args after the option separator", () => {
    expect(
      parseArgs(["image", "--all-providers", "--project", "tooling", "--", "-t", "media-smoke"]),
    ).toMatchObject({
      suites: ["image"],
      requireAuth: false,
      passthroughArgs: ["--project", "tooling", "-t", "media-smoke"],
    });
  });

  it("parses the explicit empty-run escape hatch", () => {
    expect(parseArgs(["--allow-empty"])).toMatchObject({
      allowEmpty: true,
      requireAuth: true,
    });
  });

  it("fails explicit suite selections that auth filtering would skip", () => {
    const options = parseArgs([
      "image",
      "music",
      "--image-providers",
      "openai",
      "--music-providers",
      "minimax",
    ]);
    const skipped = findSkippedExplicitProviderSelections(options, [
      { suite: MEDIA_SUITES.image, providers: ["openai"] },
      {
        suite: MEDIA_SUITES.music,
        providers: [],
        skippedReason: "no providers with usable auth",
      },
    ]);

    expect(skipped.map((entry) => entry.suite.id)).toEqual(["music"]);
  });

  it("does not fail global provider filters for suites without provider overlap", () => {
    const options = parseArgs(["image", "music", "video", "--providers", "openai"]);
    const skipped = findSkippedExplicitProviderSelections(options, [
      { suite: MEDIA_SUITES.image, providers: ["openai"] },
      {
        suite: MEDIA_SUITES.music,
        providers: [],
        skippedReason: "no providers selected",
      },
      { suite: MEDIA_SUITES.video, providers: ["openai"] },
    ]);

    expect(skipped).toEqual([]);
  });

  it("fails default live media runs when auth filtering leaves no providers", async () => {
    await expect(
      runCli(["image"], {
        buildRunPlanImpl: () => [
          {
            providers: [],
            skippedReason: "no providers with usable auth",
            suite: MEDIA_SUITES.image,
          },
        ],
      }),
    ).resolves.toBe(1);
  });

  it("allows empty live media runs only with an explicit escape hatch", async () => {
    await expect(
      runCli(["image", "--allow-empty"], {
        buildRunPlanImpl: () => [
          {
            providers: [],
            skippedReason: "no providers with usable auth",
            suite: MEDIA_SUITES.image,
          },
        ],
      }),
    ).resolves.toBe(0);
  });

  it("defaults to all suites with auth filtering", async () => {
    vi.stubEnv("TEST_AUTH_OPENAI", "1");
    vi.stubEnv("TEST_AUTH_GOOGLE", "1");
    vi.stubEnv("TEST_AUTH_MINIMAX", "1");
    vi.stubEnv("TEST_AUTH_FAL", "1");
    vi.stubEnv("TEST_AUTH_VYDRA", "1");

    const plan = await buildRunPlan(parseArgs([]), {
      collectProviderApiKeysImpl: collectProviderApiKeysMock,
      getProviderEnvVarsImpl: (provider) => [`TEST_AUTH_${provider.toUpperCase()}`],
      loadShellEnvFallbackImpl: loadShellEnvFallbackMock,
    });

    expect(plan.map((entry) => entry.suite.id)).toEqual(["image", "music", "video"]);
    expect(requirePlanEntry(plan, "image").providers).toEqual([
      "fal",
      "google",
      "minimax",
      "openai",
      "vydra",
    ]);
    expect(requirePlanEntry(plan, "music").providers).toEqual(["fal", "google", "minimax"]);
    expect(requirePlanEntry(plan, "video").providers).toEqual([
      "google",
      "minimax",
      "openai",
      "vydra",
    ]);
  });

  it("supports suite-specific provider filters without auth narrowing", async () => {
    const plan = await buildRunPlan(
      parseArgs(["video", "--video-providers", "fal,openai,runway", "--all-providers"]),
      {
        collectProviderApiKeysImpl: collectProviderApiKeysMock,
        getProviderEnvVarsImpl: (provider) => [`TEST_AUTH_${provider.toUpperCase()}`],
        loadShellEnvFallbackImpl: loadShellEnvFallbackMock,
      },
    );

    expect(plan).toHaveLength(1);
    const [entry] = plan;
    expect(entry?.suite.id).toBe("video");
    expect(entry?.providers).toEqual(["fal", "openai", "runway"]);
  });

  it("forwards quiet flags separately from passthrough args", () => {
    const options = parseArgs(["image", "--quiet", "--reporter", "dot"]);

    expect(options.suites).toEqual(["image"]);
    expect(options.quietArgs).toEqual(["--quiet"]);
    expect(options.passthroughArgs).toEqual(["--reporter", "dot"]);
  });
});
