import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { withEphemeralCodexAuthStore } from "./auth-start-options.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import type { CodexConfigReadResponse, CodexInitializeResponse } from "./protocol.js";
import { createStdioTransport } from "./transport-stdio.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

const baseUrl = "http://127.0.0.1:9/config-override-probe";
const rootOverrides = [
  "-c",
  `openai_base_url=${JSON.stringify(baseUrl)}`,
  "--config",
  "model_reasoning_effort=high",
];
const mixedArgs = [
  `-copenai_base_url=${JSON.stringify(baseUrl)}`,
  "--config=model_reasoning_effort=low",
  "--config=model_context_window=8192",
  "-cmodel_auto_compact_token_limit=6000",
  "--config=model_auto_compact_token_limit_scope=total",
  "--disable",
  "fast_mode",
  "app-server",
  "-c=model_reasoning_effort=high",
  "--config",
  'cli_auth_credentials_store="file"',
  "--listen",
  "stdio://",
];
const expectedConfig = {
  openai_base_url: baseUrl,
  model_reasoning_effort: "high",
  cli_auth_credentials_store: "ephemeral",
};
const expectedMixedConfig = {
  ...expectedConfig,
  model_context_window: 8192,
  model_auto_compact_token_limit: 6000,
  model_auto_compact_token_limit_scope: "total",
  features: { fast_mode: false },
};

type NativeConfigCase = {
  name: string;
  invocation: (
    command: string,
    launcher: string,
  ) => Pick<CodexAppServerStartOptions, "command" | "args">;
  expected: CodexConfigReadResponse["config"];
  authProfileId?: null;
  posixOnly?: boolean;
  managed?: boolean;
};

const cases: NativeConfigCase[] = [
  {
    name: "loader-owned managed package entrypoint",
    invocation: () => ({ command: "codex", args: [...mixedArgs] }),
    expected: expectedMixedConfig,
    managed: true,
  },
  {
    name: "root overrides with injected auth",
    invocation: (command) => ({
      command,
      args: [...rootOverrides, "app-server", "--listen", "stdio://"],
    }),
    expected: expectedConfig,
  },
  {
    name: "mixed override spellings and last-value precedence",
    invocation: (command) => ({ command, args: [...mixedArgs] }),
    expected: expectedMixedConfig,
  },
  {
    name: "wrapper prefix and option terminator",
    invocation: (_command, launcher) => ({
      command: process.execPath,
      args: [launcher, ...mixedArgs, "--"],
    }),
    expected: expectedMixedConfig,
  },
  {
    name: "shell-owned -c and -- prefix",
    invocation: (command) => ({
      command: "/bin/sh",
      args: ["-c", 'exec "$@"', "--", command, ...mixedArgs, "--"],
    }),
    expected: expectedMixedConfig,
    posixOnly: true,
  },
  {
    name: "wrapper-supplied subcommand with marker-shaped root values",
    invocation: (command) => ({
      command: "/bin/sh",
      args: [
        "-c",
        'exec "$@" app-server --listen stdio://',
        "--",
        command,
        "--model",
        "app-server",
        "--image",
        "photo.png",
        "app-server",
        ...rootOverrides,
      ],
    }),
    expected: expectedConfig,
    posixOnly: true,
  },
  {
    name: "native-owned auth without injection",
    invocation: (command) => ({ command, args: [...mixedArgs] }),
    expected: { ...expectedMixedConfig, cli_auth_credentials_store: "file" },
    authProfileId: null,
  },
];

async function readNativeConfig(startOptions: CodexAppServerStartOptions, env: NodeJS.ProcessEnv) {
  const child = await createStdioTransport(startOptions, env);
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });
  child.stdin.on("error", () => {});
  try {
    return await new Promise<CodexConfigReadResponse>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Native config read timed out: ${stderr}`)),
        60_000,
      );
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.once("error", reject);
      child.once("close", () => {
        clearTimeout(timeout);
        reject(new Error(`Native config process closed before config/read: ${stderr}`));
      });
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line) as {
            id?: number;
            error?: unknown;
            result?: CodexInitializeResponse | CodexConfigReadResponse;
          };
          if (message.error) {
            throw new Error(JSON.stringify(message.error));
          }
          if (message.id === 1) {
            const initialized = message.result as CodexInitializeResponse;
            expect(initialized.userAgent).toContain(`/${CODEX_APP_SERVER_VERSION} `);
            send({ method: "initialized", params: {} });
            send({
              id: 2,
              method: "config/read",
              params: { includeLayers: false, cwd: startOptions.cwd },
            });
          } else if (message.id === 2) {
            clearTimeout(timeout);
            resolve(message.result as CodexConfigReadResponse);
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(new Error("Native config response failed", { cause: error }));
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "openclaw_config_test", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  } finally {
    lines.close();
    expect(await closeCodexAppServerTransportAndWait(child)).toBe(true);
    await closed;
  }
}

describe("Codex stdio effective configuration", () => {
  it.for(cases)("preserves $name", { timeout: 75_000 }, async (testCase, context) => {
    if (testCase.posixOnly && process.platform === "win32") {
      context.skip();
    }
    await withTempDir("openclaw-codex-config-", async (dir) => {
      const root = await fs.realpath(dir);
      const { command, launcher, cwd, codexHome, env } = await createCodexNativeTestState(root);
      // No auth, inference, model discovery, or operator-home access is needed.
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        'cli_auth_credentials_store="file"\n[features]\nrespect_system_proxy=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n',
      );
      const options: CodexAppServerStartOptions = {
        ...testCase.invocation(command, launcher),
        transport: "stdio",
        commandSource: testCase.managed ? "managed" : "config",
        cwd,
        headers: {},
      };
      const start = withEphemeralCodexAuthStore({
        startOptions: await resolveManagedCodexAppServerStartOptions(options, {
          pluginRoot: fileURLToPath(new URL("../../", import.meta.url)),
        }),
        authProfileId: testCase.authProfileId,
      });
      const { config } = await readNativeConfig(start, env);
      expect(config).toMatchObject(testCase.expected);
      await expect(fs.access(path.join(codexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
