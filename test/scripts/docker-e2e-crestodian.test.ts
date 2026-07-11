// Crestodian Docker E2E tests cover packaged-dist harness wiring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readScript(pathname: string): string {
  return readFileSync(pathname, "utf8");
}

describe("Crestodian Docker E2E scripts", () => {
  it("keeps first-run checks wired to packaged CLI and Crestodian behavior", () => {
    const source = readScript("test/e2e/qa-lab/runtime/crestodian-first-run-docker-client.ts");
    const spec = readScript("scripts/e2e/crestodian-first-run-spec.json");

    expect(source).toContain("../../../../dist/cli/run-main.js");
    expect(source).toContain("../../../../dist/crestodian/setup-inference.js");
    expect(source).toContain("shouldStartOnboardingForFreshInstall");
    expect(source).toContain("Crestodian did not fail closed without inference");
    expect(source).toContain("activateSetupInference({");
    expect(source).toContain('runPackagedCli(["crestodian", "--message", "overview"])');
    expect(source).toContain("const PACKAGED_CLI_TIMEOUT_MS = 60_000");
    expect(source).toContain("inference activation did not send the live model probe");
    expect(source).toContain("function resolveDefaultModel(config: OpenClawConfig)");
    expect(source).toContain("resolveDefaultModel(config) === spec.model");
    expect(source).toContain("Fake Claude planner selected an inference-backed typed setup.");
    expect(source).toContain("[crestodian] interpreted: ${plannerCommand}");
    expect(source).toContain("expected one fuzzy setup planner prompt");
    expect(source).toContain('runPackagedCli(["plugins", "list", "--json"])');
    expect(source).toContain(
      "Telegram channel config did not auto-enable the packaged Telegram plugin",
    );
    expect(source).toContain("Crestodian first-run Docker E2E passed");
    expect(spec).toContain('"auditOperations"');
    expect(spec).toContain('"crestodian.setup"');
    expect(spec).toContain('"model": "claude-cli/claude-opus-4-8"');
    expect(spec).toContain('"planner": true');
    expect(spec).toContain('"telegramEnv": "TELEGRAM_BOT_TOKEN"');
    expect(spec).toContain("config set-ref channels.telegram.botToken env {telegramEnv}");
    expect(spec).not.toContain("plugins.allow");
    expect(spec).not.toContain("plugins.entries.telegram.enabled");
    expect(spec).not.toContain("channels.discord");
  });

  it("keeps rescue checks wired through auto-reply command handling", () => {
    const shell = readScript("scripts/e2e/crestodian-rescue-docker.sh");
    const source = readScript("scripts/e2e/crestodian-rescue-docker-client.ts");

    expect(shell).toContain("OPENCLAW_GATEWAY_TOKEN=crestodian-rescue-token");
    expect(source).toContain("../../dist/auto-reply/reply/commands-crestodian.js");
    expect(source).toContain("../../dist/crestodian/rescue-message.js");
    expect(source).toContain("handleCrestodianCommand(");
    expect(source).toContain("runCrestodianRescueMessage({");
    expect(source).toContain("sandboxing is active");
    expect(source).toContain("cannot open the local TUI");
    expect(source).toContain("[crestodian] done: gateway.restart");
    expect(source).toContain("[crestodian] done: doctor.fix");
    expect(source).toContain("Crestodian rescue Docker E2E passed");
  });
});
