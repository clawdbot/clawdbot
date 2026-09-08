// QA Lab product proof for doctor gateway auth and SecretRef behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsiSequences } from "../../../../packages/terminal-core/src/ansi.js";
import { createConfigIO } from "../../../../src/config/io.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { withSecureTestNodeCommand } from "../../../../src/secrets/test-node-command.test-support.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

let instance: OpenClawTestInstance | undefined;
type GatewayToken = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"];
const DOCTOR_CLI_TIMEOUT_MS = 120_000;
const DOCTOR_CLI_CALL_COUNT = 6;
// Entry-point preparation can precede the first CLI timeout; reserve one more
// command budget for instance and config setup across the scenario.
const DOCTOR_SCENARIO_TIMEOUT_MS = DOCTOR_CLI_TIMEOUT_MS * (DOCTOR_CLI_CALL_COUNT + 2);

afterEach(async () => {
  await instance?.cleanup();
  instance = undefined;
});

function outputOf(result: { stderr: string; stdout: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

function normalizedOutputOf(result: { stderr: string; stdout: string }): string {
  return stripAnsiSequences(outputOf(result)).replaceAll("│", " ").replace(/\s+/g, " ").trim();
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const activeInstance = instance;
  if (!activeInstance) {
    throw new Error("Doctor test instance is not initialized");
  }
  const io = createConfigIO({
    env: activeInstance.env,
    configPath: activeInstance.configPath,
    homedir: () => activeInstance.homeDir,
  });
  // Keep Doctor-authored fields so the next scenario is not a config-clobber recovery.
  await io.writeConfigFile({ ...(await io.readSourceConfigBestEffort()), ...config });
}

function localGatewayConfig(token?: GatewayToken): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      port: instance?.port,
      bind: "loopback",
      auth: {
        mode: "token",
        ...(token === undefined ? {} : { token }),
      },
      controlUi: { enabled: false },
    },
  };
}

// Windows ACL failure diagnostics are owned by focused resolver and Doctor
// tests; this broad process proof owns the platform-neutral product flow.
describe.skipIf(process.platform === "win32")("doctor auth and SecretRef product proof", () => {
  it(
    "preserves SecretRef ownership while proving resolution, fallback, exec gating, and token generation",
    { timeout: DOCTOR_SCENARIO_TIMEOUT_MS },
    async () => {
      instance = await createOpenClawTestInstance({
        name: "qa-doctor-auth-secretref",
      });

      const resolvedValue = "qa-resolved-gateway-value";
      instance.env.QA_DOCTOR_GATEWAY_TOKEN = resolvedValue;
      await writeConfig(
        localGatewayConfig({
          source: "env",
          provider: "default",
          id: "QA_DOCTOR_GATEWAY_TOKEN",
        }),
      );
      const resolved = await instance.cli(
        ["doctor", "--non-interactive", "--no-workspace-suggestions"],
        { timeoutMs: DOCTOR_CLI_TIMEOUT_MS },
      );
      const resolvedOutput = outputOf(resolved);
      expect(resolved.code).toBe(0);
      expect(resolvedOutput).not.toContain("Gateway token SecretRef could not be resolved");
      expect(resolvedOutput).not.toContain(resolvedValue);

      delete instance.env.QA_DOCTOR_MISSING_GATEWAY_TOKEN;
      instance.env.OPENCLAW_GATEWAY_TOKEN = "qa-ambient-token-must-not-win";
      const unresolvedRef = {
        source: "env" as const,
        provider: "default",
        id: "QA_DOCTOR_MISSING_GATEWAY_TOKEN",
      };
      await writeConfig(localGatewayConfig(unresolvedRef));
      const unresolved = await instance.cli(
        [
          "doctor",
          "--repair",
          "--yes",
          "--non-interactive",
          "--generate-gateway-token",
          "--no-workspace-suggestions",
        ],
        { timeoutMs: DOCTOR_CLI_TIMEOUT_MS },
      );
      const unresolvedOutput = outputOf(unresolved);
      expect(unresolved.code).toBe(0);
      expect(unresolvedOutput).toContain("Gateway token SecretRef could not be resolved");
      expect(unresolvedOutput).toContain(
        "Doctor will not overwrite gateway.auth.token with a plaintext value.",
      );
      expect(unresolvedOutput).not.toContain("qa-ambient-token-must-not-win");
      const unresolvedConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
        gateway?: { auth?: { token?: unknown } };
      };
      expect(unresolvedConfig.gateway?.auth?.token).toEqual(unresolvedRef);

      const filePath = path.join(instance.stateDir, "doctor-file-secretref.json");
      const fileSecret = "qa-file-token";
      await fs.writeFile(filePath, JSON.stringify({ gateway: { token: fileSecret } }), {
        mode: 0o600,
      });
      await writeConfig({
        ...localGatewayConfig({
          source: "file",
          provider: "filemain",
          id: "/gateway/token",
        }),
        secrets: {
          providers: {
            filemain: {
              source: "file",
              path: filePath,
            },
          },
        },
      });
      const fileResult = await instance.cli(
        ["doctor", "--non-interactive", "--no-workspace-suggestions"],
        { timeoutMs: DOCTOR_CLI_TIMEOUT_MS },
      );
      expect(fileResult.code).toBe(0);
      const fileOutput = normalizedOutputOf(fileResult);
      expect(fileOutput).not.toContain("Gateway token SecretRef could not be resolved");
      expect(fileOutput).not.toContain(fileSecret);

      const execMarker = path.join(instance.stateDir, "doctor-exec-secretref.marker");
      const execScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(execMarker)}, 'executed');`,
        "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { 'gateway/token': 'qa-exec-token' } }));",
      ].join("");
      const activeInstance = instance;
      await withSecureTestNodeCommand(async (command) => {
        await writeConfig({
          ...localGatewayConfig({
            source: "exec",
            provider: "execmain",
            id: "gateway/token",
          }),
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command,
                args: ["-e", execScript],
                trustedDirs: [path.dirname(command)],
              },
            },
          },
        });
        const execGated = await activeInstance.cli(
          ["doctor", "--non-interactive", "--no-workspace-suggestions"],
          { timeoutMs: DOCTOR_CLI_TIMEOUT_MS },
        );
        expect(execGated.code).toBe(0);
        expect(normalizedOutputOf(execGated)).toMatch(
          /Gateway health probes skipped because gateway credentials use an exec(?:\s|│)*SecretRef\./,
        );
        await expect(fs.access(execMarker)).rejects.toThrow();

        const execAllowed = await activeInstance.cli(
          ["doctor", "--non-interactive", "--allow-exec", "--no-workspace-suggestions"],
          { timeoutMs: DOCTOR_CLI_TIMEOUT_MS },
        );
        expect(execAllowed.code).toBe(0);
        const execAllowedOutput = normalizedOutputOf(execAllowed);
        await expect(fs.readFile(execMarker, "utf8")).resolves.toBe("executed");
        expect(execAllowedOutput).not.toContain("qa-exec-token");
      });

      delete instance.env.OPENCLAW_GATEWAY_TOKEN;
      await writeConfig(localGatewayConfig());
      const generated = await instance.cli(
        [
          "doctor",
          "--repair",
          "--yes",
          "--non-interactive",
          "--generate-gateway-token",
          "--no-workspace-suggestions",
        ],
        { timeoutMs: DOCTOR_CLI_TIMEOUT_MS },
      );
      expect(generated.code).toBe(0);
      const generatedConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
        gateway?: { auth?: { token?: unknown } };
      };
      expect(typeof generatedConfig.gateway?.auth?.token).toBe("string");
      expect(String(generatedConfig.gateway?.auth?.token).length).toBeGreaterThan(20);

      console.log(
        `[qa-doctor-auth-secretref] ${JSON.stringify({
          resolvedRefAccepted: true,
          unresolvedRefPreserved: true,
          ambientFallbackRejected: true,
          execRefGated: true,
          execRefAllowed: true,
          fileRefAllowed: true,
          generatedTokenPersisted: true,
        })}`,
      );
    },
  );
});
