// Test Live Shard tests cover test live shard script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIVE_TEST_SHARDS,
  RELEASE_LIVE_TEST_SHARDS,
  addLiveShardReportArgs,
  buildLiveShardPnpmArgs,
  buildLiveShardReportPath,
  buildLiveShardSpawnParams,
  collectAllLiveTestFiles,
  parseLiveShardArgs,
  removeLiveShardReportFile,
  selectLiveShardFiles,
  validateLiveShardReportPayload,
} from "../../scripts/test-live-shard.mjs";
import { expectNoReaddirSyncDuring } from "../../src/test-utils/fs-scan-assertions.js";

describe("scripts/test-live-shard", () => {
  const allFiles = collectAllLiveTestFiles();

  it("discovers live tests without scanning source roots in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = collectAllLiveTestFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.endsWith(".live.test.ts"))).toBe(true);
    });
  });

  it("covers every native live test and tracks provider-filtered release fanout", () => {
    const selected = RELEASE_LIVE_TEST_SHARDS.flatMap((shard) =>
      selectLiveShardFiles(shard, allFiles).map((file) => ({ file, shard })),
    );
    const selectedFiles = selected.map(({ file }) => file);
    const duplicateFiles = selectedFiles.filter(
      (file, index) => selectedFiles.indexOf(file) !== index,
    );
    const musicProviderFanout = selected
      .filter(({ file }) => file === "extensions/music-generation-providers.live.test.ts")
      .map(({ shard }) => shard)
      .toSorted();

    expect(allFiles.length).toBeGreaterThan(0);
    expect([...new Set(selectedFiles)].toSorted((a, b) => a.localeCompare(b))).toEqual(allFiles);
    expect(duplicateFiles).toEqual(["extensions/music-generation-providers.live.test.ts"]);
    expect(musicProviderFanout).toEqual([
      "native-live-extensions-media-music-google",
      "native-live-extensions-media-music-minimax",
    ]);
  });

  it("keeps aggregate shard aliases available outside the release partition", () => {
    expect(LIVE_TEST_SHARDS).toEqual([
      ...RELEASE_LIVE_TEST_SHARDS,
      "native-live-extensions-o-z",
      "native-live-extensions-media",
      "native-live-extensions-media-music",
    ]);

    const oToZAlias = selectLiveShardFiles("native-live-extensions-o-z", allFiles);
    expect(oToZAlias).toEqual(
      [
        ...selectLiveShardFiles("native-live-extensions-o-z-other", allFiles),
        ...selectLiveShardFiles("native-live-extensions-xai", allFiles),
      ].toSorted((a, b) => a.localeCompare(b)),
    );

    const mediaAlias = selectLiveShardFiles("native-live-extensions-media", allFiles);
    expect(mediaAlias).toEqual(
      [
        ...selectLiveShardFiles("native-live-extensions-media-audio", allFiles),
        ...selectLiveShardFiles("native-live-extensions-media-music", allFiles),
        ...selectLiveShardFiles("native-live-extensions-media-video", allFiles),
      ].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("keeps slow gateway backend and media-capable extension files in their own shards", () => {
    expect(selectLiveShardFiles("native-live-src-gateway-backends", allFiles)).toEqual([
      "src/gateway/gateway-acp-bind.live.test.ts",
      "src/gateway/gateway-cli-backend.live.test.ts",
      "src/gateway/gateway-codex-bind.live.test.ts",
      "src/gateway/gateway-codex-harness.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-src-gateway-core", allFiles)).toEqual([
      "src/crestodian/rescue-channel.live.test.ts",
      "src/gateway/android-node.capabilities.live.test.ts",
      "src/gateway/gateway-acp-spawn-defaults.live.test.ts",
      "src/gateway/gateway-trajectory-export.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-src-infra", allFiles)).toEqual([
      "src/infra/push-apns-http2.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-test", allFiles)).toEqual([
      "test/image-generation.infer-cli.live.test.ts",
      "test/image-generation.runtime.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-media", allFiles)).toEqual([
      "extensions/minimax/minimax.live.test.ts",
      "extensions/music-generation-providers.live.test.ts",
      "extensions/openai/openai-tts.live.test.ts",
      "extensions/video-generation-providers.live.test.ts",
      "extensions/volcengine/tts.live.test.ts",
      "extensions/vydra/vydra.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-openai", allFiles)).toEqual([
      "extensions/openai/openai-provider.live.test.ts",
      "extensions/openai/openai.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-l-n", allFiles)).toEqual([
      "extensions/memory-lancedb/memory-lancedb.live.test.ts",
      "extensions/microsoft/microsoft.live.test.ts",
      "extensions/mistral/mistral.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-moonshot", allFiles)).toEqual([
      "extensions/moonshot/moonshot.live.test.ts",
    ]);
  });

  it("keeps the Codex CLI backend live smoke on a minimal tool profile", () => {
    const source = readFileSync("src/gateway/gateway-cli-backend.live.test.ts", "utf8");

    expect(source).toContain('providerId === "codex-cli" && !schemaProbePluginPath');
    expect(source).toContain('profile: "minimal" as const');
  });

  it("rejects unknown shard names", () => {
    expect(() => selectLiveShardFiles("native-live-missing")).toThrow(/Unknown live test shard/u);
    expect(() => selectLiveShardFiles("native-live-extensions-l-z")).toThrow(
      /Unknown live test shard/u,
    );
  });

  it("parses list mode and rejects unknown live shard options", () => {
    expect(parseLiveShardArgs(["native-live-src-agents", "--list"])).toEqual({
      shard: "native-live-src-agents",
      listOnly: true,
      passthroughArgs: [],
    });

    expect(() => parseLiveShardArgs(["--lisst", "native-live-src-agents"])).toThrow(
      /Unknown option: --lisst/u,
    );
  });

  it("prints CLI help before validating shard options", () => {
    const result = spawnSync(process.execPath, ["scripts/test-live-shard.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/test-live-shard.mjs");
  });

  it("preserves Vitest passthrough args after the live shard separator", () => {
    expect(parseLiveShardArgs(["native-live-test", "--", "-t", "smoke"])).toEqual({
      shard: "native-live-test",
      listOnly: false,
      passthroughArgs: ["-t", "smoke"],
    });
    expect(buildLiveShardPnpmArgs(["test/foo.live.test.ts"], ["-t", "smoke"])).toEqual([
      "test:live",
      "--",
      "test/foo.live.test.ts",
      "-t",
      "smoke",
    ]);
  });

  it("adds JSON report evidence without dropping operator output", () => {
    const reportPath = buildLiveShardReportPath("native-live-src-agents", {
      OPENCLAW_LIVE_SHARD_REPORT_DIR: ".artifacts/live-proof",
    });

    expect(reportPath).toBe(".artifacts/live-proof/native-live-src-agents.vitest.json");
    expect(addLiveShardReportArgs(["-t", "smoke"], reportPath)).toEqual([
      "-t",
      "smoke",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=.artifacts/live-proof/native-live-src-agents.vitest.json",
    ]);
    expect(
      buildLiveShardPnpmArgs(
        ["src/agents/xai.live.test.ts"],
        addLiveShardReportArgs([], reportPath),
      ),
    ).toContain("--reporter=json");
  });

  it("fails live shard reports with no passing tests", () => {
    expect(validateLiveShardReportPayload({ numPassedTests: 1, numTotalTests: 3 })).toEqual({
      ok: true,
    });
    expect(validateLiveShardReportPayload({ numPassedTests: 4, numTotalTests: 3 })).toEqual({
      ok: false,
      reason: "Vitest report numPassedTests exceeds numTotalTests.",
    });
    expect(validateLiveShardReportPayload({ numPassedTests: 0, numTotalTests: 3 })).toEqual({
      ok: false,
      reason: "Vitest report has no passing live tests.",
    });
    expect(validateLiveShardReportPayload({ numPassedTests: 0, numTotalTests: 0 })).toEqual({
      ok: false,
      reason: "Vitest report has no passing live tests.",
    });
    expect(validateLiveShardReportPayload({ numPassedTests: 0 })).toEqual({
      ok: false,
      reason: "Vitest report numTotalTests must be a non-negative integer.",
    });
  });

  it("requires live shard report evidence for each selected file", () => {
    const payload = {
      numPassedTests: 1,
      numTotalTests: 2,
      testResults: [
        {
          name: path.join(process.cwd(), "src/gateway/gateway-acp-bind.live.test.ts"),
          assertionResults: [{ status: "passed" }],
        },
      ],
    };

    expect(
      validateLiveShardReportPayload(payload, ["src/gateway/gateway-acp-bind.live.test.ts"]),
    ).toEqual({ ok: true });
    expect(
      validateLiveShardReportPayload(payload, [
        "src/gateway/gateway-acp-bind.live.test.ts",
        "src/gateway/gateway-cli-backend.live.test.ts",
      ]),
    ).toEqual({
      ok: false,
      reason:
        "Vitest report missing selected live test file evidence: src/gateway/gateway-cli-backend.live.test.ts",
    });
    expect(
      validateLiveShardReportPayload({ numPassedTests: 1, numTotalTests: 1 }, [
        "src/gateway/gateway-acp-bind.live.test.ts",
      ]),
    ).toEqual({
      ok: false,
      reason: "Vitest report is missing testResults file evidence.",
    });
  });

  it("requires each selected live shard file to have a passing assertion", () => {
    const payload = {
      numPassedTests: 1,
      numTotalTests: 2,
      testResults: [
        {
          name: path.join(process.cwd(), "src/gateway/gateway-acp-bind.live.test.ts"),
          assertionResults: [{ status: "passed" }],
        },
        {
          name: path.join(process.cwd(), "src/agents/openai-reasoning-compat.live.test.ts"),
          assertionResults: [{ status: "skipped" }],
        },
      ],
    };

    expect(
      validateLiveShardReportPayload(payload, [
        "src/gateway/gateway-acp-bind.live.test.ts",
        "src/agents/openai-reasoning-compat.live.test.ts",
      ]),
    ).toEqual({
      ok: false,
      reason:
        "Vitest report selected live test files had no passing assertions: src/agents/openai-reasoning-compat.live.test.ts",
    });
  });

  it("allows explicitly opt-in live shard files to be skipped until their env is enabled", () => {
    const payload = {
      numPassedTests: 1,
      numTotalTests: 2,
      testResults: [
        {
          name: path.join(process.cwd(), "src/gateway/gateway-codex-harness.live.test.ts"),
          assertionResults: [{ status: "passed" }],
        },
        {
          name: path.join(process.cwd(), "src/gateway/gateway-cli-backend.live.test.ts"),
          assertionResults: [{ status: "skipped" }],
        },
      ],
    };
    const expectedFiles = [
      "src/gateway/gateway-codex-harness.live.test.ts",
      "src/gateway/gateway-cli-backend.live.test.ts",
    ];

    expect(validateLiveShardReportPayload(payload, expectedFiles, process.cwd(), {})).toEqual({
      ok: true,
    });
    expect(
      validateLiveShardReportPayload(payload, expectedFiles, process.cwd(), {
        OPENCLAW_LIVE_CLI_BACKEND: "1",
      }),
    ).toEqual({
      ok: false,
      reason:
        "Vitest report selected live test files had no passing assertions: src/gateway/gateway-cli-backend.live.test.ts",
    });
  });

  it("allows gateway core opt-in live files to be skipped until their env is enabled", () => {
    const payload = {
      numPassedTests: 1,
      numTotalTests: 2,
      testResults: [
        {
          name: path.join(process.cwd(), "src/gateway/gateway-codex-harness.live.test.ts"),
          assertionResults: [{ status: "passed" }],
        },
        {
          name: path.join(process.cwd(), "src/gateway/gateway-acp-spawn-defaults.live.test.ts"),
          assertionResults: [{ status: "skipped" }],
        },
      ],
    };
    const expectedFiles = [
      "src/gateway/gateway-codex-harness.live.test.ts",
      "src/gateway/gateway-acp-spawn-defaults.live.test.ts",
    ];

    expect(validateLiveShardReportPayload(payload, expectedFiles, process.cwd(), {})).toEqual({
      ok: true,
    });
    expect(
      validateLiveShardReportPayload(payload, expectedFiles, process.cwd(), {
        OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS: "1",
      }),
    ).toEqual({
      ok: false,
      reason:
        "Vitest report selected live test files had no passing assertions: src/gateway/gateway-acp-spawn-defaults.live.test.ts",
    });
  });

  it("does not count disabled opt-in sentinel assertions as live shard proof", () => {
    const payload = {
      numPassedTests: 1,
      numTotalTests: 2,
      testResults: [
        {
          name: path.join(process.cwd(), "src/gateway/gateway-codex-harness.live.test.ts"),
          assertionResults: [
            {
              ancestorTitles: ["gateway live (Codex harness disabled)"],
              status: "passed",
              title: "is opt-in",
            },
          ],
        },
        {
          name: path.join(process.cwd(), "src/gateway/gateway-cli-backend.live.test.ts"),
          assertionResults: [{ status: "skipped" }],
        },
      ],
    };

    expect(
      validateLiveShardReportPayload(
        payload,
        [
          "src/gateway/gateway-codex-harness.live.test.ts",
          "src/gateway/gateway-cli-backend.live.test.ts",
        ],
        process.cwd(),
        {},
      ),
    ).toEqual({
      ok: false,
      reason: "Vitest report has no enabled selected live test files with passing assertions.",
    });
  });

  it("removes stale live shard reports before running a shard", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-shard-"));
    const reportPath = path.join(root, "stale.vitest.json");
    writeFileSync(reportPath, JSON.stringify({ numPassedTests: 1, numTotalTests: 1 }), "utf8");

    try {
      removeLiveShardReportFile(reportPath);

      expect(existsSync(reportPath)).toBe(false);
      expect(() => removeLiveShardReportFile(reportPath)).not.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("spawns live shard children in a cleanup-friendly process group", () => {
    expect(buildLiveShardSpawnParams({ PATH: "/usr/bin" }, "darwin")).toEqual({
      detached: true,
      env: { PATH: "/usr/bin" },
      stdio: "inherit",
    });
    expect(buildLiveShardSpawnParams({ PATH: "/usr/bin" }, "win32")).toEqual({
      detached: false,
      env: { PATH: "/usr/bin" },
      stdio: "inherit",
    });
  });
});
