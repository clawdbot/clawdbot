// OpenClaw Docker E2E tests cover packaged-dist harness wiring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readScript(pathname: string): string {
  return readFileSync(pathname, "utf8");
}

describe("OpenClaw Docker E2E scripts", () => {
  it("keeps first-run checks wired to packaged CLI and OpenClaw behavior", () => {
    const source = readScript("test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts");
    const spec = readScript("scripts/e2e/system-agent-first-run-spec.json");

    expect(source).toContain("../../../../dist/cli/run-main.js");
    expect(source).toContain("../../../../dist/system-agent/setup-inference.js");
    expect(source).toContain("shouldStartOnboardingForFreshInstall");
    expect(source).toContain("OpenClaw did not fail closed without inference");
    expect(source).toContain("activateSetupInference({");
    expect(source).toContain("verifySetupInference");
    expect(source).toContain("runSystemAgent");
    expect(source).toContain("runPackagedOneShot(message, command.approve)");
    expect(source).toContain('"--modern"');
    expect(source).toContain(
      "modern compatibility entrypoint did not expose OpenClaw after activation",
    );
    expect(source).toContain("const PACKAGED_CLI_TIMEOUT_MS = 60_000");
    expect(source).toContain("inference activation did not send the live model probe");
    expect(source).toContain("function resolveDefaultModel(config: OpenClawConfig)");
    expect(source).toContain("resolveDefaultModel(config) === spec.model");
    expect(source).toContain("Fake Claude planner selected an inference-backed typed setup.");
    expect(source).toContain("[openclaw] interpreted: ${plannerCommand}");
    expect(source).toContain("expected one fuzzy setup planner prompt");
    expect(source).toContain("OpenClaw did not enable Discord");
    expect(source).toContain("OpenClaw did not write Discord token SecretRef");
    expect(source).toContain("OpenClaw first-run Docker E2E passed");
    expect(spec).toContain('"auditOperations"');
    expect(spec).toContain('"openclaw.setup"');
    expect(spec).toContain('"model": "claude-cli/claude-opus-4-8"');
    expect(spec).toContain('"planner": true');
    expect(source).toContain('const DISCORD_CREDENTIAL_ENV = ["DISCORD", "BOT", "TOKEN"]');
    expect(spec).toContain("config set-ref channels.discord.token env {discordEnv}");
    expect(spec).not.toContain("plugins.allow");
    expect(spec).not.toContain("plugins.entries.discord.enabled");
    expect(spec).not.toContain("channels.telegram");
  });

  it("keeps rescue checks wired through auto-reply command handling", () => {
    const shell = readScript("scripts/e2e/system-agent-rescue-docker.sh");
    const source = readScript("scripts/e2e/system-agent-rescue-docker-client.ts");

    expect(shell).toContain("OPENCLAW_GATEWAY_TOKEN=system-agent-rescue-token");
    expect(source).toContain("../../dist/auto-reply/reply/commands-system-agent.js");
    expect(source).toContain("../../dist/system-agent/rescue-message.js");
    expect(source).toContain("handleSystemAgentCommand(");
    expect(source).toContain("runSystemAgentRescueMessage({");
    expect(source).toContain("sandboxing is active");
    expect(source).toContain("cannot open the local TUI");
    expect(source).toContain("fresh rescue command did not revoke the older pending change");
    expect(source).toContain("[openclaw] done: gateway.restart");
    expect(source).toContain("remote doctor fix did not point to the local repair command");
    expect(source).toContain("remote rescue must not invoke doctor repair");
    expect(source).not.toContain("[openclaw] done: doctor.fix");
    expect(source).toContain("OpenClaw rescue Docker E2E passed");
  });
});
