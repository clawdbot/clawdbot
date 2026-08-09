// QA Lab product proof for doctor gateway auth and SecretRef behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsiSequences } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { withSecureTestNodeCommand } from "../../../../src/secrets/test-node-command.test-support.js";
import { forceNativeWindowsAclToolsUnavailable } from "../../../../src/test-utils/vitest-spies.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

let instance: OpenClawTestInstance | undefined;
type GatewayToken = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"];
const execFileAsync = promisify(execFile);
const DOCTOR_CLI_TIMEOUT_MS = 120_000;
const DOCTOR_CLI_CALL_COUNT = 6;
// Entry-point preparation can precede the first CLI timeout; reserve one more
// command budget for instance, config, and fixture setup across the scenario.
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

async function expectAclFixturePreservesExecFileContract(preloadUrl: string): Promise<void> {
  const probe = [
    'import { execFile } from "node:child_process";',
    'import { promisify } from "node:util";',
    'const promise = promisify(execFile)(process.execPath, ["--version"], { encoding: "utf8" });',
    'if (!promise.child || typeof promise.child.kill !== "function") process.exit(2);',
    "const result = await promise;",
    'if (!result || typeof result.stdout !== "string" || typeof result.stderr !== "string") process.exit(3);',
    'process.stdout.write("ok");',
  ].join("");
  const result = await execFileAsync(
    process.execPath,
    [`--import=${preloadUrl}`, "--input-type=module", "--eval", probe],
    { encoding: "utf8" },
  );
  expect(result).toEqual({ stdout: "ok", stderr: "" });
}

describe("doctor auth and SecretRef product proof", () => {
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

      const aclFixtureUrl = pathToFileURL(
        path.resolve("test/fixtures/windows-acl-tools-unavailable.mjs"),
      ).href;
      await expectAclFixturePreservesExecFileContract(aclFixtureUrl);
      if (process.platform === "win32") {
        forceNativeWindowsAclToolsUnavailable(instance.env, aclFixtureUrl);
      }

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
      if (process.platform === "win32") {
        expect(fileOutput).toMatch(
          /Gateway token SecretRef could not be resolved: .*Windows path security could not be verified\. Restore Windows path security verification, or use an existing secret file whose owner and ACLs OpenClaw can verify\./,
        );
        expect(fileOutput).not.toContain(filePath);
      } else {
        expect(fileOutput).not.toContain("Gateway token SecretRef could not be resolved");
      }
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
        if (process.platform === "win32") {
          expect(execAllowedOutput).toMatch(
            /Gateway token SecretRef could not be resolved: .*Windows path security could not be verified\. Restore Windows path security verification, or use an existing provider command whose owner and ACLs OpenClaw can verify\./,
          );
          expect(execAllowedOutput).not.toContain(command);
          expect(execAllowedOutput).not.toContain(execMarker);
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
          execRefAllowed: process.platform !== "win32",
          execRefWindowsAclBlocked: process.platform === "win32",
          fileRefAllowed: process.platform !== "win32",
          fileRefWindowsAclBlocked: process.platform === "win32",
          generatedTokenPersisted: true,
        })}`,
      );
    },
  );
});
