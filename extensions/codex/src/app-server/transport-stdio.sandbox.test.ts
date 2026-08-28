import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";
import { createStdioTransport } from "./transport-stdio.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";
import { buildTurnStartParams } from "./turn-params.js";
import { createCodexUserInputTestParams } from "./user-input-bridge.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

// This fixture replaces only model responses. Native turn processing, approvals,
// process execution, and the platform sandbox are not mocked.
describe.skipIf(process.platform !== "darwin")("native Codex turn sandbox", () => {
  it.for([
    {
      name: "raw true",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c=sandbox_workspace_write.exclude_slash_tmp=true",
        "app-server",
      ],
      excluded: true,
    },
    {
      name: "commented true",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true # exclusion retained",
        "app-server",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true # exclusion retained",
      ],
      excluded: true,
    },
    {
      name: "commented false wins last",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
        "app-server",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=false # explicit last value",
        "-c=sandbox_workspace_write.exclude_slash_tmp=false # explicit last value",
      ],
      excluded: false,
    },
  ])(
    "keeps temporary-root exclusions at the native execution boundary: $name",
    { timeout: 75_000 },
    async ({ args, excluded }, context) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-sandbox-")),
      );
      context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
      const slashTmp = await fs.realpath(await fs.mkdtemp("/tmp/codex-turn-denied-"));
      context.onTestFinished(() => fs.rm(slashTmp, { recursive: true, force: true }));
      const cwd = path.join(root, "workspace");
      const home = path.join(root, "home");
      const codexHome = path.join(home, ".codex");
      const tmp = path.join(root, "tmp");
      await Promise.all([cwd, codexHome, tmp].map((dir) => fs.mkdir(dir, { recursive: true })));
      const targets = [
        path.join(cwd, "workspace.txt"),
        path.join(slashTmp, "slash-tmp.txt"),
        path.join(tmp, "tmpdir.txt"),
      ] as const;
      // All targets are writable by this account before native containment.
      for (const target of targets) {
        await fs.writeFile(target, "control");
        await fs.unlink(target);
      }
      let requestCount = 0;
      const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          if (req.url !== "/v1/responses" || req.method !== "POST") {
            res.writeHead(404).end();
            return;
          }
          requestCount += 1;
          const script = targets
            .map(
              (target, index) =>
                `if printf proof > '${target}'; then printf 'write-${index}:ok\\n'; else printf 'write-${index}:denied\\n'; fi`,
            )
            .join("; ");
          const item =
            requestCount === 1
              ? {
                  type: "function_call",
                  call_id: "write-probe",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: script,
                    shell: "/bin/sh",
                    login: false,
                    max_output_tokens: 1000,
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: "done",
                  content: [{ type: "output_text", text: "Probe complete." }],
                };
          const events = [
            { type: "response.created", response: { id: `response-${requestCount}` } },
            { type: "response.output_item.done", item },
            {
              type: "response.completed",
              response: {
                id: `response-${requestCount}`,
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              },
            },
          ];
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        });
      });
      context.onTestFinished(async () => {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Loopback fixture has no TCP address");
      }
      const config = [
        'model="gpt-5.6-luna"',
        'model_provider="loopback-fixture"',
        'sandbox_mode="workspace-write"',
        'approval_policy="on-request"',
        'approvals_reviewer="user"',
        'cli_auth_credentials_store="ephemeral"',
        'web_search="disabled"',
        "allow_login_shell=false",
        "[features]",
        "respect_system_proxy=false",
        "shell_snapshot=false",
        "code_mode=false",
        "code_mode_only=false",
        "[analytics]",
        "enabled=false",
        "[feedback]",
        "enabled=false",
        "[model_providers.loopback-fixture]",
        'name="Loopback test fixture"',
        `base_url="http://127.0.0.1:${address.port}/v1"`,
        'wire_api="responses"',
        "requires_openai_auth=false",
        "supports_websockets=false",
      ].join("\n");
      await fs.writeFile(path.join(codexHome, "config.toml"), config);
      const require = createRequire(import.meta.url);
      const launcher = path.join(
        path.dirname(require.resolve("@openai/codex/package.json")),
        "bin/codex.js",
      );
      const command = resolveManagedCodexNativeCommand(launcher);
      if (!command) {
        throw new Error("Pinned native Codex package is required");
      }
      const proxy = "http://127.0.0.1:9";
      const env = {
        PATH: "/usr/bin:/bin",
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        SHELL: "/bin/sh",
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
      const child = createStdioTransport(
        { transport: "stdio", command, commandSource: "config", args, cwd, headers: {} },
        env,
      );
      const lines = createInterface({ input: child.stdout });
      context.onTestFinished(async () => {
        lines.close();
        expect(await closeCodexAppServerTransportAndWait(child)).toBe(true);
      });
      const pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();
      let nextId = 0;
      let approvals = 0;
      let commandOutput = "";
      let finishTurn: (value: unknown) => void = () => {};
      const completed = new Promise<unknown>((resolve) => {
        finishTurn = resolve;
      });
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const request = (method: string, params: object) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          send({ id, method, params });
        });
      child.stdin.on("error", () => {});
      child.stderr.resume();
      child.once("close", () => {
        for (const waiter of pending.values()) {
          waiter.reject(new Error("Native child closed"));
        }
      });
      lines.on("line", (line) => {
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          result?: unknown;
          error?: unknown;
          params?: { item?: { type: string; aggregatedOutput?: string }; turn?: unknown };
        };
        if (message.method && message.id !== undefined) {
          approvals += 1;
          send({
            id: message.id,
            result:
              message.method === "item/permissions/requestApproval"
                ? { permissions: {}, scope: "turn" }
                : { decision: "decline" },
          });
        } else if (message.id !== undefined) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) {
            waiter?.reject(new Error(JSON.stringify(message.error)));
          } else {
            waiter?.resolve(message.result);
          }
        } else if (
          message.method === "item/completed" &&
          message.params?.item?.type === "commandExecution"
        ) {
          commandOutput += message.params.item.aggregatedOutput ?? "";
        } else if (message.method === "turn/completed") {
          finishTurn(message.params?.turn);
        }
      });
      const initialized = await request("initialize", {
        clientInfo: { name: "openclaw_sandbox_test", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      expect(initialized).toMatchObject({
        userAgent: expect.stringContaining(`/${CODEX_APP_SERVER_VERSION} `),
      });
      send({ method: "initialized", params: {} });
      const thread = (await request("thread/start", {
        cwd,
        model: "gpt-5.6-luna",
        modelProvider: "loopback-fixture",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        ephemeral: true,
      })) as { thread: { id: string }; sandbox: unknown };
      expect(thread.sandbox).toMatchObject({
        type: "workspaceWrite",
        excludeTmpdirEnvVar: excluded,
        excludeSlashTmp: excluded,
      });
      const appServer = resolveCodexAppServerRuntimeOptions({
        env: {},
        codexConfigToml: null,
        requirementsToml: null,
        pluginConfig: {
          appServer: {
            command,
            args,
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
          },
        },
      });
      const params = createCodexUserInputTestParams();
      params.prompt = "Run the deterministic sandbox write probe.";
      const turn = buildTurnStartParams(params, {
        threadId: thread.thread.id,
        cwd,
        appServer,
        preserveNativeTurnSettings: true,
      });
      await request("turn/start", turn);
      expect(await completed).toMatchObject({ status: "completed" });
      expect(approvals).toBe(0);
      expect(requestCount).toBe(2);
      expect(commandOutput).toContain("write-0:ok");
      expect(await fs.readFile(targets[0], "utf8")).toBe("proof");
      for (const [index, target] of targets.entries()) {
        if (index === 0) {
          continue;
        }
        expect(commandOutput).toContain(`write-${index}:${excluded ? "denied" : "ok"}`);
        if (excluded) {
          expect(commandOutput).toMatch(/Operation not permitted|Permission denied/);
          await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(target, "utf8")).toBe("proof");
        }
      }
      await expect(fs.access(path.join(codexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
