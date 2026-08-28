import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { withEphemeralCodexAuthStore } from "./auth-start-options.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";
import type { CodexConfigReadResponse, CodexInitializeResponse } from "./protocol.js";
import { createStdioTransport } from "./transport-stdio.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

const require = createRequire(import.meta.url);
const launcher = path.join(
  path.dirname(require.resolve("@openai/codex/package.json")),
  "bin/codex.js",
);
const baseUrl = "http://127.0.0.1:9/config-override-probe";

async function readNativeConfig(startOptions: CodexAppServerStartOptions, env: NodeJS.ProcessEnv) {
  const child = createStdioTransport(startOptions, env);
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
  it.for([
    {
      name: "root overrides with injected auth",
      placement: "root",
      authProfileId: undefined,
      wrapped: false,
      terminator: false,
    },
    {
      name: "mixed override spellings and last-value precedence",
      placement: "mixed",
      authProfileId: undefined,
      wrapped: false,
      terminator: false,
    },
    {
      name: "wrapper prefix and option terminator",
      placement: "mixed",
      authProfileId: undefined,
      wrapped: "script",
      terminator: true,
    },
    {
      name: "shell-owned -c and -- prefix",
      placement: "mixed",
      authProfileId: undefined,
      wrapped: "shell",
      terminator: true,
    },
    {
      name: "wrapper-supplied subcommand with marker-shaped root values",
      placement: "root",
      authProfileId: undefined,
      wrapped: "implicit",
      terminator: false,
    },
    {
      name: "native-owned auth without injection",
      placement: "mixed",
      authProfileId: null,
      wrapped: false,
      terminator: false,
    },
  ] as const)(
    "preserves $name",
    { timeout: 75_000 },
    async ({ placement, authProfileId, wrapped, terminator }, context) => {
      if ((wrapped === "shell" || wrapped === "implicit") && process.platform === "win32") {
        context.skip();
      }
      await withTempDir("openclaw-codex-config-", async (dir) => {
        const home = await fs.realpath(dir);
        const codexHome = path.join(home, ".codex");
        const cwd = path.join(home, "workspace");
        const tmp = path.join(home, "tmp");
        await Promise.all([codexHome, cwd, tmp].map((entry) => fs.mkdir(entry)));
        // No auth, inference, model discovery, or operator-home access is needed.
        await fs.writeFile(
          path.join(codexHome, "config.toml"),
          'cli_auth_credentials_store="file"\n[features]\nrespect_system_proxy=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n',
        );
        const proxy = "http://127.0.0.1:9";
        const env: NodeJS.ProcessEnv = {
          PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexHome,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          XDG_STATE_HOME: path.join(home, ".local/state"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          ALL_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          all_proxy: proxy,
          NO_PROXY: "127.0.0.1,localhost,::1",
          no_proxy: "127.0.0.1,localhost,::1",
        };
        const args =
          placement === "root"
            ? [
                "-c",
                `openai_base_url=${JSON.stringify(baseUrl)}`,
                "--config",
                "model_reasoning_effort=high",
                ...(wrapped === "implicit" ? [] : ["app-server", "--listen", "stdio://"]),
              ]
            : [
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
        const nativeCommand = resolveManagedCodexNativeCommand(launcher);
        if (!nativeCommand) {
          throw new Error(
            "Install the pinned @openai/codex platform package before native config tests.",
          );
        }
        const invocation =
          wrapped === "implicit"
            ? {
                command: "/bin/sh",
                prefix: [
                  "-c",
                  'exec "$@" app-server --listen stdio://',
                  "--",
                  nativeCommand,
                  "--model",
                  "app-server",
                  "--image",
                  "photo.png",
                  "app-server",
                ],
              }
            : wrapped === "shell"
              ? { command: "/bin/sh", prefix: ["-c", 'exec "$@"', "--", nativeCommand] }
              : wrapped === "script"
                ? { command: process.execPath, prefix: [launcher] }
                : { command: nativeCommand, prefix: [] };
        const options: CodexAppServerStartOptions = {
          transport: "stdio",
          command: invocation.command,
          commandSource: "config",
          args: [...invocation.prefix, ...args, ...(terminator ? ["--"] : [])],
          cwd,
          headers: {},
        };
        const start = withEphemeralCodexAuthStore({ startOptions: options, authProfileId });
        const { config } = await readNativeConfig(start, env);
        expect(config).toMatchObject({
          openai_base_url: baseUrl,
          model_reasoning_effort: "high",
          cli_auth_credentials_store: authProfileId === null ? "file" : "ephemeral",
          ...(placement === "mixed"
            ? {
                model_context_window: 8192,
                model_auto_compact_token_limit: 6000,
                model_auto_compact_token_limit_scope: "total",
                features: { fast_mode: false },
              }
            : {}),
        });
        await expect(fs.access(path.join(codexHome, "auth.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );
});
