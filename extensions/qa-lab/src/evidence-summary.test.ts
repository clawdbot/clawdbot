// Qa Lab tests cover QA evidence summary behavior.
import { execFileSync } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  buildPlaywrightEvidenceSummary,
  buildQaSuiteEvidenceSummary,
  buildVitestEvidenceSummary,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";

describe("evidence summary", () => {
  it("builds QA suite evidence entries from catalog metadata", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [
        { kind: "summary", path: "qa-suite-summary.json" },
        { kind: "report", path: "qa-suite-report.md" },
      ],
      scenarioDefinitions: [
        {
          id: "dm-chat-baseline",
          title: "DM baseline conversation",
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.yaml",
          surface: "dm",
          coverage: {
            primary: ["channels.dm"],
            secondary: ["channels.qa-channel"],
          },
          runtimeParityTier: "standard",
          docsRefs: ["docs/channels/qa-channel.md"],
          codeRefs: ["extensions/qa-channel/src/gateway.ts"],
        },
      ],
      channelId: "qa-channel",
      env: {
        OPENCLAW_QA_CHANNEL_DRIVER: "local-shim",
        OPENCLAW_QA_REF: "abc123",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:00:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
    expect(evidence.schemaVersion).toBe(QA_EVIDENCE_SUMMARY_SCHEMA_VERSION);
    expect(evidence.evidenceMode).toBe("full");
    expect(evidence.profile).toBeUndefined();
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "qa-scenario",
        id: "dm-chat-baseline",
        title: "DM baseline conversation",
        source: {
          path: "qa/scenarios/channels/dm-chat-baseline.yaml",
        },
      },
      coverage: [
        {
          id: "channels.dm",
          role: "primary",
        },
        {
          id: "channels.qa-channel",
          role: "secondary",
        },
      ],
      refs: [
        {
          kind: "docs",
          path: "docs/channels/qa-channel.md",
        },
        {
          kind: "code",
          path: "extensions/qa-channel/src/gateway.ts",
        },
      ],
      runtimeParityTier: "standard",
      execution: {
        runner: "host",
        provider: {
          id: "openai",
          live: false,
          model: {
            name: "gpt-5.6-luna",
            ref: "mock-openai/gpt-5.6-luna",
          },
          fixture: "mock-openai",
        },
        channel: {
          id: "qa-channel",
          live: false,
          driver: "local-shim",
        },
        packageSource: {
          kind: "source-checkout",
        },
        environment: {
          ref: "abc123",
          os: process.platform,
          nodeVersion: process.version,
        },
        artifacts: [
          {
            kind: "summary",
            path: "qa-suite-summary.json",
            source: "qa-suite",
          },
          {
            kind: "report",
            path: "qa-suite-report.md",
            source: "qa-suite",
          },
        ],
      },
      result: {
        status: "pass",
      },
    });
  });

  it("prefers the checked-out ref over an inherited GitHub event SHA", () => {
    const repoRoot = process.cwd();
    const checkedOutRef = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [],
      channelId: "qa-channel",
      env: {
        GITHUB_SHA: "bd479958c04a1eadbda8b6105e0722588d71e9ad",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-24T12:00:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      repoRoot,
      scenarioDefinitions: [{ id: "ref-probe", title: "Ref probe" }],
      scenarioResults: [{ name: "Ref probe", status: "pass" }],
    });

    expect(evidence.entries[0]?.execution?.environment.ref).toBe(checkedOutRef);
  });

  it("builds Vitest runner evidence entries", () => {
    const evidence = buildVitestEvidenceSummary({
      artifactPaths: [
        { kind: "runner-result", path: "vitest-results/runtime-boundary.vitest.json" },
      ],
      env: {
        OPENCLAW_QA_REF: "abc123",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:06:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      targets: [
        {
          id: "runtime.agent-runner-boundary",
          title: "Agent runner boundary integration tests",
          sourcePath: "src/agents/agent-runner.e2e.test.ts",
          primaryCoverageIds: ["runtime.agent-runner", "runtime.delivery"],
          codeRefs: ["src/agents/agent-runner.ts"],
        },
      ],
      results: [
        {
          id: "runtime.agent-runner-boundary",
          status: "pass",
          durationMs: 1234,
        },
      ],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.profile).toBeUndefined();
    expect(evidence.entries).toEqual([
      expect.objectContaining({
        test: {
          kind: "vitest-test",
          id: "runtime.agent-runner-boundary",
          title: "Agent runner boundary integration tests",
          source: {
            path: "src/agents/agent-runner.e2e.test.ts",
          },
        },
        coverage: [
          {
            id: "runtime.agent-runner",
            role: "primary",
          },
          {
            id: "runtime.delivery",
            role: "primary",
          },
        ],
        refs: [
          {
            kind: "code",
            path: "src/agents/agent-runner.ts",
          },
        ],
        execution: expect.objectContaining({
          runner: "vitest",
          provider: expect.objectContaining({
            live: false,
            fixture: "mock-openai",
          }),
          artifacts: [
            {
              kind: "runner-result",
              path: "vitest-results/runtime-boundary.vitest.json",
              source: "vitest",
            },
          ],
        }),
        result: {
          status: "pass",
          timing: {
            wallMs: 1234,
          },
        },
      }),
    ]);
  });

  it("builds Playwright runner evidence entries", () => {
    const evidence = buildPlaywrightEvidenceSummary({
      artifactPaths: [
        { kind: "runner-result", path: "playwright-results/control-ui.json" },
        { kind: "report", path: "playwright-report/index.html" },
      ],
      env: {
        GITHUB_SHA: "def456",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:07:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      targets: [
        {
          id: "control-ui.browser-run",
          title: "Control UI browser workflow",
          sourcePath: "ui/control-ui.e2e.test.ts",
          primaryCoverageIds: ["ui.control"],
          docsRefs: ["docs/concepts/qa-e2e-automation.md"],
          codeRefs: ["ui/"],
        },
      ],
      results: [
        {
          id: "control-ui.browser-run",
          status: "fail",
          durationMs: 2300,
          failureMessage: "locator timed out",
        },
      ],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.profile).toBeUndefined();
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "playwright-test",
        id: "control-ui.browser-run",
        title: "Control UI browser workflow",
        source: {
          path: "ui/control-ui.e2e.test.ts",
        },
      },
      coverage: [
        {
          id: "ui.control",
          role: "primary",
        },
      ],
      refs: [
        {
          kind: "docs",
          path: "docs/concepts/qa-e2e-automation.md",
        },
        {
          kind: "code",
          path: "ui/",
        },
      ],
      execution: {
        runner: "playwright",
        artifacts: [
          {
            kind: "runner-result",
            path: "playwright-results/control-ui.json",
            source: "playwright",
          },
          {
            kind: "report",
            path: "playwright-report/index.html",
            source: "playwright",
          },
        ],
      },
      result: {
        status: "fail",
        failure: {
          reason: "locator timed out",
        },
        timing: {
          wallMs: 2300,
        },
      },
    });
  });

  it("carries profile env values without hardcoding taxonomy coverage ids", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [{ kind: "summary", path: "qa-suite-summary.json" }],
      scenarioDefinitions: [
        {
          id: "dm-chat-baseline",
          title: "DM baseline conversation",
          surface: "dm",
          coverage: {
            primary: ["channels.dm"],
          },
        },
      ],
      channelId: "qa-channel",
      env: {
        OPENCLAW_QA_PROFILE: "experimental-profile",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:09:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
    });

    expect(evidence.profile).toBe("experimental-profile");
  });

  it.each([
    { evidenceMode: undefined, expectedMode: "slim", hasExecution: false },
    { evidenceMode: "full" as const, expectedMode: "full", hasExecution: true },
  ])(
    "resolves profile evidence mode $expectedMode",
    ({ evidenceMode, expectedMode, hasExecution }) => {
      const evidence = buildQaSuiteEvidenceSummary({
        artifactPaths: [{ kind: "summary", path: "qa-suite-summary.json" }],
        ...(evidenceMode ? { evidenceMode } : {}),
        profile: "smoke-ci",
        scenarioDefinitions: [
          {
            id: "dm-chat-baseline",
            title: "DM baseline conversation",
            coverage: {
              primary: ["channels.dm"],
            },
          },
        ],
        channelId: "qa-channel",
        generatedAt: "2026-06-07T12:09:00.000Z",
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
      });

      expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
      expect(evidence.evidenceMode).toBe(expectedMode);
      expect("execution" in expectDefined(evidence.entries[0], "QA evidence entry")).toBe(
        hasExecution,
      );
    },
  );

  it("keeps mock non-OpenAI model refs attributed to their model provider", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [{ kind: "summary", path: "qa-suite-summary.json" }],
      scenarioDefinitions: [
        {
          id: "anthropic-parity",
          title: "Anthropic parity",
          surface: "runtime",
          coverage: {
            primary: ["providers.anthropic"],
          },
        },
      ],
      channelId: "qa-channel",
      generatedAt: "2026-06-07T12:10:00.000Z",
      primaryModel: "anthropic/claude-opus-4-8",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "Anthropic parity", status: "pass" }],
    });

    expect(evidence.entries[0]?.execution).toMatchObject({
      provider: {
        id: "anthropic",
        model: {
          name: "claude-opus-4-8",
          ref: "anthropic/claude-opus-4-8",
        },
      },
    });
    expect(evidence.entries[0]).toMatchObject({
      execution: {
        provider: {
          live: false,
          fixture: "mock-openai",
        },
      },
    });
  });
});
