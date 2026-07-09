// Release Candidate Checklist tests cover release candidate checklist script behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildPublishCommand,
  candidateParallelsArgs,
  candidateParallelsShellCommand,
  githubApi,
  parseArgs,
  parseRunIdFromDispatchOutput,
  resolveArtifactName,
  requireRunIdFromDispatchOutput,
  validateFullManifest,
  validatePreflightManifest,
  validateWindowsSourceRelease,
} from "../../scripts/release-candidate-checklist.mjs";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

async function withGithubApiTimeoutEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
  process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = previous;
    }
  }
}

describe("release candidate checklist", () => {
  it("infers validation profiles from candidate tags", () => {
    expect(parseArgs(["--tag", "v2026.5.14-beta.3"]).releaseProfile).toBe("beta");
    expect(parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "v0.6.3"]).releaseProfile).toBe(
      "stable",
    );
    expect(
      parseArgs([
        "--tag",
        "v2026.5.14",
        "--windows-node-tag",
        "v0.6.3",
        "--release-profile",
        "full",
      ]).releaseProfile,
    ).toBe("full");
  });

  it("runs Parallels against the exact prepared candidate tarball", () => {
    expect(candidateParallelsArgs(".artifacts/preflight/openclaw.tgz")).toEqual([
      "test:parallels:npm-update",
      "--",
      "--target-tarball",
      ".artifacts/preflight/openclaw.tgz",
      "--json",
    ]);
    expect(
      candidateParallelsShellCommand(
        ".artifacts/preflight/openclaw candidate.tgz",
        "/opt/homebrew/bin/gtimeout",
      ),
    ).toContain(
      "set -a; source \"$HOME/.profile\" >/dev/null 2>&1 || true; set +a; exec '/opt/homebrew/bin/gtimeout' --foreground 150m pnpm",
    );
    expect(
      candidateParallelsShellCommand(
        ".artifacts/preflight/openclaw candidate.tgz",
        "/opt/homebrew/bin/gtimeout",
        [".artifacts/preflight/openclaw-ai candidate.tgz"],
      ),
    ).toContain("'--target-tarball' '.artifacts/preflight/openclaw candidate.tgz'");
    expect(
      candidateParallelsArgs(".artifacts/preflight/openclaw.tgz", [
        ".artifacts/preflight/openclaw-ai.tgz",
      ]),
    ).toEqual([
      "test:parallels:npm-update",
      "--",
      "--target-tarball",
      ".artifacts/preflight/openclaw.tgz",
      "--dependency-tarball",
      ".artifacts/preflight/openclaw-ai.tgz",
      "--json",
    ]);
  });

  it("requires exact dependency tarball metadata in npm preflight manifests", () => {
    const manifest = {
      releaseTag: "v2026.7.1-beta.3",
      releaseSha: "candidate-sha",
      npmDistTag: "beta",
      tarballName: "openclaw-2026.7.1-beta.3.tgz",
      tarballSha256: "root-sha",
      dependencyTarballs: [
        {
          packageName: "@openclaw/ai",
          packageVersion: "2026.7.1-beta.3",
          tarballName: "openclaw-ai-2026.7.1-beta.3.tgz",
          tarballSha256: "ai-sha",
        },
      ],
    };
    const params = {
      tag: "v2026.7.1-beta.3",
      targetSha: "candidate-sha",
      npmDistTag: "beta",
    };

    expect(() => validatePreflightManifest(manifest, params)).not.toThrow();
    expect(() =>
      validatePreflightManifest({ ...manifest, dependencyTarballs: undefined }, params),
    ).toThrow("missing dependency tarball metadata");
    expect(() =>
      validatePreflightManifest(
        {
          ...manifest,
          dependencyTarballs: [
            {
              ...manifest.dependencyTarballs[0],
              tarballName: "../openclaw-ai.tgz",
            },
          ],
        },
        params,
      ),
    ).toThrow("invalid dependency tarball metadata");
  });

  it("requires run ids when dispatch is disabled", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14-beta.3", "--skip-dispatch"])).toThrow(
      "--skip-dispatch requires --full-release-run and --npm-preflight-run",
    );
  });

  it("rejects duplicate release candidate CLI options", () => {
    const requiredArgs = ["--tag", "v2026.5.14-beta.3"];
    const duplicateOption = (
      flag: string,
      firstValue: string,
      secondValue: string,
      prefix = requiredArgs,
    ): [string, string[]] => [flag, [...prefix, flag, firstValue, flag, secondValue]];
    const duplicateFlag = (flag: string): [string, string[]] => [
      flag,
      [...requiredArgs, flag, flag],
    ];
    const duplicateCases = [
      duplicateOption("--tag", "v2026.5.14-beta.3", "v2026.5.14-beta.4", []),
      duplicateOption("--workflow-ref", "release/a", "release/b"),
      duplicateOption("--repo", "openclaw/openclaw", "fork/openclaw"),
      duplicateOption("--full-release-run", "111", "222"),
      duplicateOption("--npm-preflight-run", "111", "222"),
      duplicateOption("--windows-node-tag", "v0.6.3", "v0.6.4"),
      duplicateFlag("--skip-dispatch"),
      duplicateFlag("--skip-local-generated-check"),
      duplicateFlag("--skip-parallels"),
      duplicateFlag("--skip-telegram"),
      duplicateOption("--telegram-provider-mode", "mock-openai", "live-frontier"),
      duplicateOption("--provider", "blacksmith-testbox", "crabbox"),
      duplicateOption("--mode", "fresh", "upgrade"),
      duplicateOption("--release-profile", "beta", "stable"),
      duplicateOption("--npm-dist-tag", "beta", "latest"),
      duplicateOption("--plugin-publish-scope", "all-publishable", "selected"),
      duplicateOption("--plugins", "telegram", "discord"),
      duplicateOption("--output-dir", ".artifacts/a", ".artifacts/b"),
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args), flag).toThrow(`${flag} was provided more than once`);
    }
  });

  it("requires stable validation evidence to include soak and blocking performance", () => {
    const stableManifest = {
      workflowName: "Full Release Validation",
      targetSha: "candidate-sha",
      releaseProfile: "stable",
      rerunGroup: "all",
      runReleaseSoak: "true",
      controls: { performanceBlocking: true },
    };

    expect(() =>
      validateFullManifest(stableManifest, {
        targetSha: "candidate-sha",
        releaseProfile: "stable",
      }),
    ).not.toThrow();

    expect(() =>
      validateFullManifest(
        {
          ...stableManifest,
          runReleaseSoak: "false",
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "stable",
        },
      ),
    ).toThrow("runReleaseSoak=true");
    expect(() =>
      validateFullManifest(
        {
          ...stableManifest,
          controls: { performanceBlocking: false },
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "stable",
        },
      ),
    ).toThrow("blocking product performance");
  });

  it("stops parsing options after the argument terminator", () => {
    const options = parseArgs([
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--",
      "--plugin-publish-scope",
      "selected",
    ]);

    expect(options.pluginPublishScope).toBe("all-publishable");
  });

  it("accepts package-manager argument separators before script options", () => {
    const options = parseArgs([
      "--",
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--skip-parallels",
    ]);

    expect(options.tag).toBe("v2026.5.14-beta.3");
    expect(options.skipParallels).toBe(true);
  });

  it("builds the gated release publish command from green evidence inputs", () => {
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--workflow-ref",
        "release/2026.5.14",
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--skip-dispatch",
      ]),
      workflowRef: "release/2026.5.14",
    };

    expect(buildPublishCommand(options)).toContain("'full_release_validation_run_id=111'");
    expect(buildPublishCommand(options)).toContain("'preflight_run_id=222'");
    expect(buildPublishCommand(options)).toContain("'tag=v2026.5.14-beta.3'");
    expect(buildPublishCommand(options)).toContain("'plugin_publish_scope=all-publishable'");
    expect(buildPublishCommand(options)).not.toContain("windows_node_tag=");
  });

  it("requires and carries an exact Windows Node tag for stable release candidates", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14"])).toThrow(
      "stable release candidates require --windows-node-tag",
    );
    expect(() => parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "latest"])).toThrow(
      "--windows-node-tag must be an explicit version tag, not latest",
    );

    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14",
        "--windows-node-tag",
        "v0.6.3",
        "--workflow-ref",
        "release/2026.5.14",
      ]),
      workflowRef: "release/2026.5.14",
      windowsNodeInstallerDigests: JSON.stringify({
        "OpenClawCompanion-Setup-x64.exe": `sha256:${"a".repeat(64)}`,
        "OpenClawCompanion-Setup-arm64.exe": `sha256:${"b".repeat(64)}`,
      }),
    };

    expect(buildPublishCommand(options)).toContain("'windows_node_tag=v0.6.3'");
    expect(buildPublishCommand(options)).toContain(
      `'windows_node_installer_digests={"OpenClawCompanion-Setup-x64.exe":"sha256:${"a".repeat(64)}","OpenClawCompanion-Setup-arm64.exe":"sha256:${"b".repeat(64)}"}'`,
    );
  });

  it("validates the stable Windows source release and immutable installer digests", async () => {
    const assets = [
      {
        name: "OpenClawCompanion-Setup-x64.exe",
        digest: `sha256:${"a".repeat(64)}`,
      },
      {
        name: "OpenClawCompanion-Setup-arm64.exe",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ];
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        tag_name: "v0.6.3",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
        assets,
      });
    });

    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).resolves.toEqual({
      tag: "v0.6.3",
      url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
      assets,
    });
  });

  it.each([
    [{ draft: true }, "must be published"],
    [{ prerelease: true }, "must not be a prerelease"],
    [{ tag_name: "v0.6.4" }, "Windows source release tag mismatch: expected v0.6.3, got v0.6.4"],
    [
      { assets: [] },
      "must contain exactly one required asset OpenClawCompanion-Setup-x64.exe; found 0",
    ],
    [
      {
        assets: [
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"a".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"c".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-arm64.exe",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
      },
      "must contain exactly one required asset OpenClawCompanion-Setup-x64.exe; found 2",
    ],
    [
      {
        assets: [
          { name: "OpenClawCompanion-Setup-x64.exe", digest: "" },
          { name: "OpenClawCompanion-Setup-arm64.exe", digest: `sha256:${"b".repeat(64)}` },
        ],
      },
      "asset OpenClawCompanion-Setup-x64.exe is missing its SHA-256 digest",
    ],
  ])("rejects an invalid stable Windows source release", async (override, message) => {
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        tag_name: "v0.6.3",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
        assets: [
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"a".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-arm64.exe",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
        ...override,
      });
    });

    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(message);
  });

  it("carries the Telegram proof run into the publish command when available", () => {
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--workflow-ref",
        "release/2026.5.14",
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--skip-dispatch",
      ]),
      workflowRef: "release/2026.5.14",
      npmTelegramRunId: "333",
    };

    expect(buildPublishCommand(options)).toContain("'npm_telegram_run_id=333'");
  });

  it("requires explicit plugin names for selected plugin publish scope", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--plugin-publish-scope", "selected"]),
    ).toThrow("--plugin-publish-scope selected requires --plugins");
  });

  it("rejects selected plugin publish scope for release candidates", () => {
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--plugin-publish-scope",
        "selected",
        "--plugins",
        "@openclaw/diffs",
      ]),
    ).toThrow("release candidates publish OpenClaw with --plugin-publish-scope all-publishable");
  });

  it("extracts a workflow run id from gh dispatch output", () => {
    expect(
      parseRunIdFromDispatchOutput(
        "https://github.com/openclaw/openclaw/actions/runs/25922042055\n",
      ),
    ).toBe("25922042055");
  });

  it("fails closed when gh dispatch output does not include the run url", () => {
    expect(() =>
      requireRunIdFromDispatchOutput(
        "Created workflow_dispatch event for full-release-validation.yml",
        "full-release-validation.yml",
      ),
    ).toThrow("refusing to guess from recent workflow_dispatch runs");
  });

  it("falls back to a single compatible artifact from the same run", () => {
    expect(
      resolveArtifactName(
        [{ name: "openclaw-npm-preflight-dba00", expired: false }],
        "openclaw-npm-preflight-v2026.5.16-beta.2",
        "openclaw-npm-preflight-",
      ),
    ).toBe("openclaw-npm-preflight-dba00");
  });

  it("bounds GitHub API requests with a timeout signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        Authorization: "Bearer test-token",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      return jsonResponse({ workflow_runs: [] });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).resolves.toEqual({ workflow_runs: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/openclaw/actions/runs",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses a positive integer GitHub API timeout env", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ workflow_runs: [] });
    });

    await withGithubApiTimeoutEnv("2500", async () => {
      await expect(
        githubApi("repos/openclaw/openclaw/actions/runs", {
          fetchImpl,
          token: "test-token",
        }),
      ).resolves.toEqual({ workflow_runs: [] });
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["1e3", "10.5", "0", "soon"])(
    "rejects malformed GitHub API timeout env %s",
    async (raw) => {
      const fetchImpl = vi.fn();

      await withGithubApiTimeoutEnv(raw, async () => {
        await expect(
          githubApi("repos/openclaw/openclaw/actions/runs", {
            fetchImpl,
            token: "test-token",
          }),
        ).rejects.toThrow(
          "OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS must be a positive integer",
        );
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("bounds GitHub API error bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("x".repeat(65), {
        headers: { "content-length": "65" },
        status: 500,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        maxBodyBytes: 64,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(
      "GitHub API repos/openclaw/openclaw/actions/runs response body exceeded 64 bytes",
    );
  });

  it("keeps GitHub API timeouts active while reading response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        timeoutMs: 25,
        token: "test-token",
      }),
    ).rejects.toThrow("GitHub API repos/openclaw/openclaw/actions/runs timed out after 25ms");
  });

  it("includes the GitHub API path when a request times out", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("request timed out", "TimeoutError");
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs/123/jobs", {
        fetchImpl,
        timeoutMs: 5,
        token: "test-token",
      }),
    ).rejects.toThrow(
      "GitHub API repos/openclaw/openclaw/actions/runs/123/jobs timed out after 5ms",
    );
  });
});
