// QA Lab product proof for doctor gateway auth and SecretRef behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsiSequences } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { withSecureTestNodeCommand } from "../../../../src/secrets/test-node-command.test-support.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

let instance: OpenClawTestInstance | undefined;
type GatewayToken = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"];

afterEach(async () => {
  await instance?.cleanup();
  instance = undefined;
});

function outputOf(result: { stderr: string; stdout: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

function normalizedOutputOf(result: { stderr: string; stdout: string }): string {
  return stripAnsiSequences(outputOf(result)).replace(/\s+/g, " ").trim();
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  await instance?.state.writeConfig(config);
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

describe("doctor auth and SecretRef product proof", () => {
  it(
    "preserves SecretRef ownership while proving resolution, fallback, exec gating, and token generation",
    { timeout: 240_000 },
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
        { timeoutMs: 120_000 },
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
        { timeoutMs: 120_000 },
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
          { timeoutMs: 120_000 },
        );
        expect(execGated.code).toBe(0);
        expect(normalizedOutputOf(execGated)).toMatch(
          /Gateway health probes skipped because gateway credentials use an exec(?:\s|│)*SecretRef\./,
        );
        await expect(fs.access(execMarker)).rejects.toThrow();

        const execAllowed = await activeInstance.cli(
          ["doctor", "--non-interactive", "--allow-exec", "--no-workspace-suggestions"],
          { timeoutMs: 120_000 },
        );
        expect(execAllowed.code).toBe(0);
        const execAllowedOutput = normalizedOutputOf(execAllowed);
        if (process.platform === "win32") {
          expect(execAllowedOutput).toMatch(
            /Gateway token SecretRef could not be resolved: .*ACL verification unavailable on Windows/,
          );
          await expect(fs.access(execMarker)).rejects.toThrow();
        } else {
          await expect(fs.readFile(execMarker, "utf8")).resolves.toBe("executed");
        }
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
        { timeoutMs: 120_000 },
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
          execRefAllowed: process.platform !== "win32",
          execRefWindowsAclBlocked: process.platform === "win32",
          generatedTokenPersisted: true,
        })}`,
      );
    },
  );
});
