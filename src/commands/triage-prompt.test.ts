import { describe, expect, it } from "vitest";
import type { HealthFinding } from "../flows/health-checks.js";
import { renderTriagePrompt } from "./triage-prompt.js";

describe("renderTriagePrompt", () => {
  const homeDir = "/home/triage-test";
  const redaction = {
    env: { HOME: homeDir },
    stateDir: `${homeDir}/.openclaw`,
  };

  it("orders sanitized findings by severity and includes repair hints and bundle details", () => {
    const findings: HealthFinding[] = [
      { checkId: "core/info", severity: "info", message: "informational" },
      { checkId: "core/warning", severity: "warning", message: "needs attention" },
      {
        checkId: "core/error",
        severity: "error",
        message: "model routing failed",
        fixHint: "Run `openclaw doctor --fix`.",
      },
    ];

    const prompt = renderTriagePrompt({
      findings,
      bundle: { kind: "available", path: `${redaction.stateDir}/diagnostics.zip` },
      redaction,
    });

    expect(prompt.indexOf("[error]")).toBeLessThan(prompt.indexOf("[warning]"));
    expect(prompt.indexOf("[warning]")).toBeLessThan(prompt.indexOf("[info]"));
    expect(prompt).toContain("Fix: Run `openclaw doctor --fix`.");
    expect(prompt).toContain("Sanitized ZIP: $OPENCLAW_STATE_DIR/diagnostics.zip");
    expect(prompt).toContain("Secrets, tokens, raw chat payloads, and raw logs are excluded");
  });

  it("redacts home and state paths across finding fields and diagnostics handoffs", () => {
    const prompt = renderTriagePrompt({
      findings: [
        {
          checkId: `${homeDir}/checks/config`,
          severity: "error",
          message: `Config: ${redaction.stateDir}/openclaw.json\nneeds repair`,
          fixHint: `Inspect ${homeDir}/logs/gateway.log`,
        },
      ],
      bundle: { kind: "available", path: `${homeDir}/Downloads/diagnostics.zip` },
      redaction,
    });

    expect(prompt).toContain(
      "[error] ~/checks/config: Config: $OPENCLAW_STATE_DIR/openclaw.json needs repair",
    );
    expect(prompt).toContain("Fix: Inspect ~/logs/gateway.log");
    expect(prompt).toContain("Sanitized ZIP: ~/Downloads/diagnostics.zip");
    expect(prompt).not.toContain(homeDir);
  });

  it("hard-bounds multibyte findings and explicitly reports omitted findings", () => {
    const findings: HealthFinding[] = Array.from({ length: 25 }, (_, index) => ({
      checkId: `core/check-${index}`,
      severity: "warning",
      message: "🦞".repeat(4_000),
      fixHint: "修".repeat(4_000),
    }));

    const prompt = renderTriagePrompt({
      findings,
      bundle: { kind: "skipped" },
      redaction,
      updateFailure: { error: "Original update failure: " + "🦞".repeat(4_000) },
    });

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(prompt).toContain("Original update failure:");
    // Every finding is either rendered or explicitly counted as omitted, and the
    // trailing sections survive because findings are fitted to the byte budget.
    const rendered = prompt.match(/^- \[warning\]/gmu)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(prompt).toContain(
      `${findings.length - rendered} more findings omitted; run \`openclaw doctor\` for the full list.`,
    );
    expect(prompt).toContain("## Privacy");
    expect(prompt).not.toContain("\uFFFD");
    expect(prompt).toContain("...");
  });

  it("keeps the failed attempt ahead of healthy Doctor results and sanitizes its evidence", () => {
    const secret = "sk-test-update-triage-secret-1234567890";
    const prompt = renderTriagePrompt({
      findings: [],
      bundle: { kind: "skipped" },
      redaction,
      updateFailure: {
        result: {
          status: "error",
          mode: "npm",
          root: `${homeDir}/npm/openclaw`,
          reason: "npm install failed",
          before: { version: "2026.8.1" },
          after: { version: "2026.9.1" },
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          steps: [
            { name: "npm install", exitCode: 1, stderrTail: `Authorization: Bearer ${secret}` },
          ],
        },
      },
    });

    expect(prompt.indexOf("## Failed update")).toBeLessThan(prompt.indexOf("## Doctor findings"));
    expect(prompt).toContain("npm install failed");
    expect(prompt).toContain("2026.8.1");
    expect(prompt).toContain("2026.9.1");
    expect(prompt).toContain('"serviceRestartSafe":false');
    expect(prompt).toContain("No advisory doctor findings were reported.");
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain(homeDir);
  });

  it("fits whole failure records without losing the latest cause or restart safety", () => {
    const noisy = '\\"'.repeat(1_000);
    const prompt = renderTriagePrompt({
      findings: [],
      bundle: { kind: "skipped" },
      redaction,
      updateFailure: {
        error: `Original update failure ${noisy}`,
        result: {
          status: "error",
          mode: "npm",
          reason: `runtime-check-failed ${noisy}`,
          root: `${homeDir}/${noisy}`,
          before: { sha: noisy, version: noisy },
          after: { sha: noisy, version: noisy },
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          steps: Array.from({ length: 6 }, (_, index) => ({
            name: `step-${index} ${noisy}`,
            exitCode: 1,
            stdoutTail: `${noisy} actual-compiler-cause-${index}`,
            stderrTail: `${noisy} npm failure footer`,
          })),
          postUpdate: {
            plugins: {
              status: "error",
              reason: `plugin-finalization-failed ${noisy}`,
              warnings: Array.from({ length: 5 }, (_, index) => ({
                pluginId: noisy,
                reason: `Doctor cause-${index} ${noisy}`,
                message: noisy,
              })),
            },
          },
        },
      },
    });
    const details = prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "";
    const recorded = JSON.parse(details) as { omittedDetails: number };

    expect(recorded).toMatchObject({
      error: expect.stringContaining("Original update failure"),
      result: {
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        steps: expect.arrayContaining([
          expect.objectContaining({
            stdoutTail: expect.stringContaining("actual-compiler-cause-5"),
          }),
        ]),
        postUpdate: {
          plugins: {
            warnings: expect.arrayContaining([
              expect.objectContaining({ reason: expect.stringContaining("Doctor cause-4") }),
            ]),
          },
        },
      },
    });
    expect(recorded.omittedDetails).toBeGreaterThan(0);
    expect(Buffer.byteLength(details)).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
    expect(prompt).toContain("## Privacy");
    expect(prompt).not.toContain("\uFFFD");
  });

  it.each([
    {
      bundle: { kind: "unavailable" as const, reason: "Gateway unreachable" },
      text: "Diagnostics export unavailable: Gateway unreachable",
    },
    {
      bundle: {
        kind: "unavailable" as const,
        reason: `Gateway config: ${redaction.stateDir}/openclaw.json`,
      },
      text: "Diagnostics export unavailable: Gateway config: $OPENCLAW_STATE_DIR/openclaw.json",
    },
    {
      bundle: { kind: "skipped" as const },
      text: "Diagnostics export skipped with `--no-export`.",
    },
  ])("explains absent diagnostics archives: $text", ({ bundle, text }) => {
    expect(renderTriagePrompt({ findings: [], bundle, redaction })).toContain(text);
  });
});
