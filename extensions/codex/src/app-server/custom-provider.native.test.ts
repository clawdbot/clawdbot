import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import {
  createCustomProviderTestServer,
  customProviderTestConfig,
  writeCustomProviderTestResponse,
} from "./custom-provider.test-support.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { withTimeout } from "./timeout.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(() => vi.unstubAllEnvs());

const PROVIDER = "test-proxy";
const MODEL = "gpt-5.2-codex";
const REQUEST_OPTIONS = { timeoutMs: 20_000 };

async function createProviderFixture(context: TestContext, nativeShellProbe = false) {
  const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
  const root = await fs.realpath(tempDirs.make("codex-custom-provider-"));
  const native = await createCodexNativeTestState(root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const requests: {
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    account: string | undefined;
    body: string;
  }[] = [];
  const shellOutputs: string[] = [];
  let shellToolName: string | undefined;
  let shellProbeSent = false;
  const baseUrl = await createCustomProviderTestServer((request, response, requestBody) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"]?.toString(),
      body: requestBody,
    });
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    let shellItem: Record<string, unknown> | undefined;
    if (nativeShellProbe) {
      const body: unknown = JSON.parse(requestBody);
      if (!isJsonObject(body)) {
        response.writeHead(400).end();
        return;
      }
      if (Array.isArray(body.input)) {
        for (const item of body.input) {
          if (
            isJsonObject(item) &&
            item.type === "function_call_output" &&
            item.call_id === "native-key-probe"
          ) {
            shellOutputs.push(
              typeof item.output === "string" ? item.output : JSON.stringify(item.output),
            );
          }
        }
      }
      if (!shellProbeSent) {
        const tool = Array.isArray(body.tools)
          ? body.tools.find(
              (entry) =>
                isJsonObject(entry) &&
                (entry.name === "exec_command" || entry.name === "shell_command"),
            )
          : undefined;
        if (!isJsonObject(tool) || typeof tool.name !== "string") {
          response.writeHead(400).end("Native shell tool was not advertised");
          return;
        }
        shellToolName = tool.name;
        // Report only status markers: neither the credential nor its length may leave the shell.
        const command = [
          'if [ -n "$CODEX_API_KEY" ]; then printf "%s\\n" credential-visible; exit 31; fi',
          'if [ "$OPENCLAW_NATIVE_ENV_MARKER" != "preserved-marker" ]; then printf "%s\\n" marker-missing; exit 32; fi',
          'printf "%s\\n" native-shell-clean',
        ].join("\n");
        shellItem = {
          type: "function_call",
          call_id: "native-key-probe",
          name: shellToolName,
          arguments: JSON.stringify(
            shellToolName === "exec_command"
              ? {
                  cmd: command,
                  shell: "/bin/sh",
                  login: false,
                  max_output_tokens: 1000,
                  yield_time_ms: 1000,
                }
              : { command, workdir: native.cwd, timeout_ms: 10_000 },
          ),
        };
        shellProbeSent = true;
      }
    }
    const id = `fixture-response-${requests.length}`;
    writeCustomProviderTestResponse(
      response,
      id,
      shellItem ?? {
        type: "message",
        role: "assistant",
        id: `fixture-answer-${requests.length}`,
        content: [{ type: "output_text", text: "Prepared provider reached." }],
      },
      { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    );
  }, context.onTestFinished);
  const configFile = path.join(native.codexHome, "config.toml");
  const nativeAuthFile = path.join(native.codexHome, "auth.json");
  const nativeAuth = JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: "synthetic-native-key",
  });
  await fs.writeFile(nativeAuthFile, nativeAuth);
  const configToml = [
    customProviderTestConfig({ model: MODEL, provider: PROVIDER, baseUrl, sandbox: "read-only" }),
    ...(nativeShellProbe
      ? ["[shell_environment_policy]", 'inherit="all"', "ignore_default_excludes=true"]
      : []),
  ].join("\n");
  await fs.writeFile(configFile, configToml);
  const childEnv = {
    ...Object.fromEntries(
      Object.entries(native.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    OPENAI_API_KEY: "synthetic-ambient-key",
    CODEX_API_KEY: "synthetic-stale-provider-key",
    OPENCLAW_NATIVE_ENV_MARKER: "preserved-marker",
  };
  const open = async (apiKey: string, route = { provider: PROVIDER, baseUrl }) => {
    const client = await createIsolatedCodexAppServerClient({
      startOptions: {
        transport: "stdio",
        homeScope: "agent",
        command: native.command,
        commandSource: "config",
        args: ["app-server"],
        cwd: native.cwd,
        headers: {},
        env: childEnv,
        clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
      },
      agentDir: path.join(root, "agent"),
      preparedAuth: {
        kind: "api-key",
        apiKey,
        customProvider: route,
      },
      authRequirement: "api-key",
      config: {},
      timeoutMs: 20_000,
    });
    context.onTestFinished(async () =>
      expect(await client.closeAndWait()).toMatchObject({ exited: true }),
    );
    expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
    return client;
  };
  return {
    native,
    requests,
    open,
    configFile,
    configToml,
    nativeAuthFile,
    nativeAuth,
    shellOutputs,
    readShellToolName: () => shellToolName,
  };
}

async function completeTurn(client: CodexAppServerClient, threadId: string) {
  const completed = createDeferred<unknown>();
  const removeHandler = client.addNotificationHandler((notification) => {
    if (
      notification.method === "turn/completed" &&
      isJsonObject(notification.params) &&
      notification.params.threadId === threadId
    ) {
      completed.resolve(notification.params.turn);
    }
  });
  try {
    await client.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "Reply briefly.", text_elements: [] }] },
      REQUEST_OPTIONS,
    );
    await expect(
      withTimeout(completed.promise, 20_000, "Native provider turn timed out"),
    ).resolves.toMatchObject({ status: "completed" });
  } finally {
    removeHandler();
  }
}

describe("native Codex prepared custom provider", () => {
  it.for([false, true])(
    "keeps the workload key out of model-driven native shell tools (thread override: %s)",
    { timeout: 60_000 },
    async (overrideThreadEnvironment, context) => {
      const fixture = await createProviderFixture(context, true);
      const client = await fixture.open("synthetic-prepared-model-shell-key");
      const started = await client.request(
        "thread/start",
        {
          model: MODEL,
          modelProvider: PROVIDER,
          cwd: fixture.native.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ...(overrideThreadEnvironment
            ? {
                config: {
                  shell_environment_policy: {
                    inherit: "all",
                    ignore_default_excludes: true,
                    set: {
                      CODEX_API_KEY: "synthetic-attempted-thread-override",
                      OPENCLAW_NATIVE_ENV_MARKER: "preserved-marker",
                    },
                  },
                },
              }
            : {}),
        },
        REQUEST_OPTIONS,
      );
      await completeTurn(client, started.thread.id);
      expect(["exec_command", "shell_command"]).toContain(fixture.readShellToolName());
      expect(fixture.shellOutputs).toHaveLength(1);
      expect(fixture.shellOutputs[0]).toContain("native-shell-clean");
      expect(fixture.shellOutputs[0]).not.toMatch(/credential-visible|marker-missing/);
      expect(fixture.requests.map(({ authorization }) => authorization)).toEqual([
        "Bearer synthetic-prepared-model-shell-key",
        "Bearer synthetic-prepared-model-shell-key",
      ]);
    },
  );

  it(
    "keeps the workload key out of native command environments",
    { timeout: 30_000 },
    async (context) => {
      const fixture = await createProviderFixture(context);
      const client = await fixture.open("synthetic-prepared-shell-key");
      const result = await client.request(
        "command/exec",
        {
          command: ["/bin/sh", "-c", 'test -z "$CODEX_API_KEY"'],
          timeoutMs: 10_000,
        },
        REQUEST_OPTIONS,
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
      expect(fixture.requests).toHaveLength(0);
    },
  );

  it(
    "uses only the prepared bearer key across cold resume, key rotation, and fork",
    { timeout: 90_000 },
    async (context) => {
      const fixture = await createProviderFixture(context);
      const first = await fixture.open("synthetic-prepared-key-one");
      const started = await first.request(
        "thread/start",
        {
          model: MODEL,
          modelProvider: PROVIDER,
          cwd: fixture.native.cwd,
        },
        REQUEST_OPTIONS,
      );
      expect(started.modelProvider).toBe(PROVIDER);
      await completeTurn(first, started.thread.id);
      expect(await first.closeAndWait()).toMatchObject({ exited: true });

      const second = await fixture.open("synthetic-prepared-key-two");
      const resumed = await second.request(
        "thread/resume",
        {
          threadId: started.thread.id,
          model: MODEL,
          modelProvider: PROVIDER,
          cwd: fixture.native.cwd,
        },
        REQUEST_OPTIONS,
      );
      expect(resumed.thread.id).toBe(started.thread.id);
      expect(resumed.modelProvider).toBe(PROVIDER);
      await completeTurn(second, resumed.thread.id);
      const forked = await second.request(
        "thread/fork",
        {
          threadId: resumed.thread.id,
          model: MODEL,
          modelProvider: PROVIDER,
          cwd: fixture.native.cwd,
        },
        REQUEST_OPTIONS,
      );
      expect(forked.thread.id).not.toBe(resumed.thread.id);
      expect(forked.modelProvider).toBe(PROVIDER);
      await completeTurn(second, forked.thread.id);
      expect(
        fixture.requests.map(({ authorization, account }) => ({ authorization, account })),
      ).toEqual([
        { authorization: "Bearer synthetic-prepared-key-one", account: undefined },
        { authorization: "Bearer synthetic-prepared-key-two", account: undefined },
        { authorization: "Bearer synthetic-prepared-key-two", account: undefined },
      ]);
      for (const request of fixture.requests) {
        expect(request).toMatchObject({ method: "POST", url: "/v1/responses" });
        expect(JSON.parse(request.body)).toMatchObject({ model: MODEL, stream: true });
      }
      await expect(second.request("account/read", { refreshToken: false })).resolves.toMatchObject({
        account: null,
      });
      const history = await second.request("thread/read", {
        threadId: resumed.thread.id,
        includeTurns: true,
      });
      expect(JSON.stringify(history.thread.turns)).toContain("Prepared provider reached.");
      expect(await fs.readFile(fixture.nativeAuthFile, "utf8")).toBe(fixture.nativeAuth);
    },
  );

  it.for(["thread/resume", "thread/fork"] as const)(
    "switches providers through %s without losing native history",
    { timeout: 60_000 },
    async (method, context) => {
      const fixture = await createProviderFixture(context);
      const first = await fixture.open("synthetic-source-key");
      const started = await first.request(
        "thread/start",
        { model: MODEL, modelProvider: PROVIDER, cwd: fixture.native.cwd },
        REQUEST_OPTIONS,
      );
      await completeTurn(first, started.thread.id);
      expect(await first.closeAndWait()).toMatchObject({ exited: true });

      const targetRequests: { authorization?: string; body: string }[] = [];
      const baseUrl = await createCustomProviderTestServer((request, response, body) => {
        targetRequests.push({ authorization: request.headers.authorization, body });
        writeCustomProviderTestResponse(
          response,
          "target-response",
          {
            type: "message",
            role: "assistant",
            id: "target-answer",
            content: [{ type: "output_text", text: "Target provider reached." }],
          },
          { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        );
      }, context.onTestFinished);
      const target = { provider: "target-proxy", baseUrl };
      await fs.writeFile(
        fixture.configFile,
        customProviderTestConfig({ model: MODEL, ...target, sandbox: "read-only" }),
      );
      const second = await fixture.open("synthetic-target-key", target);
      for (const inferenceMethod of ["turn/start", "thread/compact/start"] as const) {
        await expect(
          second.request(inferenceMethod, { threadId: started.thread.id }, REQUEST_OPTIONS),
        ).rejects.toThrow("different provider");
      }
      expect(targetRequests).toHaveLength(0);
      const changed = await second.request(
        method,
        {
          threadId: started.thread.id,
          model: MODEL,
          modelProvider: target.provider,
          cwd: fixture.native.cwd,
        },
        REQUEST_OPTIONS,
      );
      expect(changed.modelProvider).toBe(target.provider);
      if (method === "thread/resume") {
        expect(changed.thread.id).toBe(started.thread.id);
      } else {
        expect(changed.thread.id).not.toBe(started.thread.id);
        expect(changed.thread.forkedFromId).toBe(started.thread.id);
      }
      await completeTurn(second, changed.thread.id);
      expect(fixture.requests).toHaveLength(1);
      expect(targetRequests).toHaveLength(1);
      expect(targetRequests[0]?.authorization).toBe("Bearer synthetic-target-key");
      expect(targetRequests[0]?.body).toContain("Prepared provider reached.");
      const history = await second.request("thread/read", {
        threadId: changed.thread.id,
        includeTurns: true,
      });
      expect(changed.thread.sessionId).toEqual(expect.any(String));
      expect(history.thread.sessionId).toBe(changed.thread.sessionId);
      expect(JSON.stringify(history.thread.turns)).toContain("Prepared provider reached.");
      expect(JSON.stringify(history.thread.turns)).toContain("Target provider reached.");
    },
  );

  it(
    "rejects request routing overrides and config drift after a successful turn",
    { timeout: 60_000 },
    async (context) => {
      const fixture = await createProviderFixture(context);
      const client = await fixture.open("synthetic-prepared-key");
      const started = await client.request(
        "thread/start",
        {
          model: MODEL,
          modelProvider: PROVIDER,
          cwd: fixture.native.cwd,
        },
        REQUEST_OPTIONS,
      );
      await completeTurn(client, started.thread.id);
      expect(fixture.requests).toHaveLength(1);

      await expect(
        client.request(
          "thread/start",
          {
            model: MODEL,
            modelProvider: PROVIDER,
            cwd: fixture.native.cwd,
            config: {
              model_providers: {
                [PROVIDER]: { base_url: "http://127.0.0.1:9/override" },
              },
            },
          },
          REQUEST_OPTIONS,
        ),
      ).rejects.toThrow(
        "Codex custom provider thread config cannot override model routing or authentication",
      );
      expect(fixture.requests).toHaveLength(1);

      await fs.writeFile(
        fixture.configFile,
        fixture.configToml.replace('/v1"', '/changed-endpoint"'),
      );
      await expect(
        client.request(
          "turn/start",
          {
            threadId: started.thread.id,
            input: [
              { type: "text", text: "This turn must not reach inference.", text_elements: [] },
            ],
          },
          REQUEST_OPTIONS,
        ),
      ).rejects.toThrow(
        "Codex custom provider endpoint does not match the prepared OpenClaw route",
      );
      expect(fixture.requests).toHaveLength(1);
      expect(await fs.readFile(fixture.nativeAuthFile, "utf8")).toBe(fixture.nativeAuth);
    },
  );

  it.for([
    {
      name: "a different endpoint",
      from: '/v1"',
      to: '/wrong-route"',
      error: "Codex custom provider endpoint does not match the prepared OpenClaw route",
    },
    {
      name: "an unbound environment key",
      from: 'env_key="CODEX_API_KEY"',
      to: 'env_key="OPENAI_API_KEY"',
      error: "Codex custom provider requires Responses",
    },
    {
      name: "an unknown provider ID",
      from: `[model_providers.${PROVIDER}]`,
      to: "[model_providers.another-provider]",
      error: "Codex custom provider is missing from the running server's effective config",
    },
    {
      name: "native OpenAI account authentication",
      from: "requires_openai_auth=false",
      to: "requires_openai_auth=true",
      error: "Codex custom provider requires Responses",
    },
  ])(
    "rejects $name before inference",
    { timeout: 40_000 },
    async ({ from, to, error }, context) => {
      const fixture = await createProviderFixture(context);
      await fs.writeFile(fixture.configFile, fixture.configToml.replace(from, to));
      await expect(fixture.open("synthetic-prepared-key")).rejects.toThrow(error);
      expect(fixture.requests).toEqual([]);
      expect(await fs.readFile(fixture.nativeAuthFile, "utf8")).toBe(fixture.nativeAuth);
    },
  );
});
