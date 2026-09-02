import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type {
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListModelAccountsResult,
  UsersSelfResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { ExitError } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  modelsAccountsClearDefaultCommand,
  modelsAccountsLoginCommand,
  modelsAccountsListCommand,
  modelsAccountsUseCommand,
} from "./accounts.js";

const mocks = vi.hoisted(() => ({
  password: vi.fn<typeof import("@clack/prompts").password>(),
  openUrl: vi.fn(async () => false),
}));
vi.mock("@clack/prompts", () => ({ password: mocks.password }));
vi.mock("../../infra/browser-open.js", () => ({ openUrl: mocks.openUrl }));

const PROFILE_ID = "person-test";
const ACCOUNT_ID = "personal-account-first";
const connected = {
  status: "connected",
  authProfileId: ACCOUNT_ID,
  links: [{ provider: "openai", authProfileId: ACCOUNT_ID, updatedAt: 1 }],
} satisfies UsersAuthConnectStatusResult;
const self = {
  profile: {
    id: PROFILE_ID,
    displayName: "Test Person",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 1,
    emails: [],
    githubIdentity: null,
    hasAvatar: false,
  },
} satisfies UsersSelfResult;

type Request = {
  method: string;
  params: Record<string, unknown>;
  socket: WebSocket;
};

async function withGateway(
  respond: (request: Request) => unknown,
  run: (gateway: {
    port: string;
    url: string;
    requests: Request[];
    connections: Request[];
    upgradeHeaders: IncomingHttpHeaders[];
  }) => Promise<void>,
  options: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await withOpenClawTestState(
    { label: "personal-account-cli", scenario: "minimal", env: options.env },
    async (state) => {
      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      const requests: Request[] = [];
      const connections: Request[] = [];
      const upgradeHeaders: IncomingHttpHeaders[] = [];
      server.on("connection", (socket, upgrade) => {
        upgradeHeaders.push(upgrade.headers);
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const frame = parseMinimalGatewayRequestFrame(data);
          if (!frame.id || !frame.method) {
            return;
          }
          const id = frame.id;
          const request = { method: frame.method, params: frame.params ?? {}, socket };
          if (frame.method === "connect") {
            connections.push(request);
            sendMinimalGatewayResponse(socket, id, buildMinimalGatewayHelloOkPayload());
            return;
          }
          requests.push(request);
          void Promise.resolve()
            .then(() => respond(request))
            .then(
              (payload) => {
                if (socket.readyState === WebSocket.OPEN) {
                  sendMinimalGatewayResponse(
                    socket,
                    id,
                    payload ?? (request.method === "users.self" ? self : {}),
                  );
                }
                return undefined;
              },
              () => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(
                    JSON.stringify({
                      type: "res",
                      id,
                      ok: false,
                      error: { code: "FORBIDDEN", message: "Requires an authenticated user" },
                    }),
                  );
                }
                return undefined;
              },
            );
        });
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral Gateway port.");
      }
      await state.writeConfig(
        options.config ?? {
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
        },
      );
      try {
        await run({
          port: String(address.port),
          url: `ws://127.0.0.1:${address.port}`,
          requests,
          connections,
          upgradeHeaders,
        });
      } finally {
        await closeMinimalGatewayServer(server);
      }
    },
  );
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: (code: number) => {
      throw new ExitError(code);
    },
  };
}

function expectJsonOutput(output: ReturnType<typeof runtime>, payload: unknown): void {
  expect(output.writeJson.mock.calls.map(([value]) => value)).toEqual([payload]);
}

function expectPersonalContext(output: ReturnType<typeof runtime>, url: string): void {
  const diagnostics = output.error.mock.calls.map(([line]) => String(line)).join("\n");
  expect(diagnostics).toContain("Scope: Personal");
  expect(diagnostics).toContain(`Gateway: ${url}`);
  expect(diagnostics).toContain(`Person: ${self.profile.displayName}`);
}

function startResult(): UsersAuthConnectStartResult {
  return {
    connectId: "operation-one",
    url: "https://auth.example/authorize?state=synthetic-state",
    autoCallback: true,
    expiresAtMs: Date.now() + 60_000,
  };
}

function waitForPromptAbort(): void {
  mocks.password.mockImplementation(
    ({ signal }) =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(Symbol("cancel"));
        } else {
          signal?.addEventListener("abort", () => resolve(Symbol("cancel")), { once: true });
        }
      }),
  );
}

const ttyDescriptors = [process.stdin, process.stderr].map(
  (stream) => [stream, Object.getOwnPropertyDescriptor(stream, "isTTY")] as const,
);
beforeEach(() => {
  for (const [stream] of ttyDescriptors) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  }
  mocks.password.mockReset();
  mocks.openUrl.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of ttyDescriptors) {
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
});

describe("personal model account CLI over an identified Gateway connection", () => {
  it("prints one metadata page and its next cursor without fetching another page", async () => {
    const page: UsersListModelAccountsResult = {
      profileId: PROFILE_ID,
      accounts: [
        {
          authProfileId: ACCOUNT_ID,
          provider: "openai",
          label: "Work",
          authType: "oauth",
          selected: true,
        },
      ],
      nextCursor: ACCOUNT_ID,
      links: connected.links,
    };
    const output = runtime();
    await withGateway(
      ({ method }) => (method === "users.listModelAccounts" ? page : undefined),
      async ({ port, url, requests, connections }) => {
        await modelsAccountsListCommand({ port, cursor: "previous-account", json: true }, output);
        expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
          { method: "users.self", params: {} },
          { method: "users.listModelAccounts", params: { cursor: "previous-account" } },
        ]);
        expectJsonOutput(output, page);
        expectPersonalContext(output, url);
        expect(output.log).not.toHaveBeenCalled();
        expect(connections).toHaveLength(1);
        expect(connections[0]?.params.device).toEqual(
          expect.objectContaining({ nonce: "test-nonce" }),
        );
        expect(connections[0]?.params.scopes).toEqual(["operator.read"]);
      },
    );
  });

  it("uses a credential-free explicit URL without leaking ambient, configured, or other-edge auth", async () => {
    const page = {
      profileId: PROFILE_ID,
      accounts: [],
      links: [],
    } satisfies UsersListModelAccountsResult;
    const output = runtime();
    await withGateway(
      ({ method }) => (method === "users.listModelAccounts" ? page : undefined),
      async ({ url, requests, connections, upgradeHeaders }) => {
        await modelsAccountsListCommand({ url, json: true }, output);
        expect(requests.map(({ method }) => method)).toEqual([
          "users.self",
          "users.listModelAccounts",
        ]);
        expect(connections).toHaveLength(1);
        expect(connections[0]?.params.auth).toBeUndefined();
        expect(upgradeHeaders[0]?.["x-edge-auth"]).toBeUndefined();
        expectPersonalContext(output, url);
        expectJsonOutput(output, page);
      },
      {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "ambient-shared-token",
          OPENCLAW_GATEWAY_PASSWORD: "ambient-shared-password",
        },
        config: {
          gateway: {
            mode: "remote",
            auth: { mode: "token", token: "configured-local-token" },
            remote: {
              url: "wss://different-gateway.example/control",
              token: "configured-remote-token",
              password: "configured-remote-password",
              edgeAuth: { "X-Edge-Auth": "configured-other-edge-token" },
            },
          },
        },
      },
    );
  });

  it.each([
    {
      run: (port: string, output: ReturnType<typeof runtime>) =>
        modelsAccountsUseCommand({ port, authProfileId: ACCOUNT_ID }, output),
      method: "users.selectModelAccount",
      params: { profileId: PROFILE_ID, authProfileId: ACCOUNT_ID },
      note: "Existing sessions keep",
    },
    {
      run: (port: string, output: ReturnType<typeof runtime>) =>
        modelsAccountsClearDefaultCommand({ port, provider: "openai" }, output),
      method: "users.unlinkAuthProfile",
      params: { profileId: PROFILE_ID, provider: "openai" },
      note: "Saved credentials and existing session accounts are unchanged",
    },
  ])(
    "binds $method to the authenticated person without changing sessions",
    async ({ run, method, params, note }) => {
      const output = runtime();
      await withGateway(
        (request) => (request.method === method ? { links: connected.links } : undefined),
        async ({ port, url, requests, connections }) => {
          await run(port, output);
          expect(
            requests.map(({ method: rpc, params: args }) => ({ method: rpc, params: args })),
          ).toEqual([
            { method: "users.self", params: {} },
            { method, params },
          ]);
          expect(connections).toHaveLength(1);
          expectPersonalContext(output, url);
          expect(output.log).toHaveBeenCalledWith(expect.stringContaining(note));
        },
      );
    },
  );

  it.each([{ action: "login" }, { action: "list" }])(
    "guides an unidentified person through $action without prompting for provider credentials",
    async ({ action }) => {
      const output = runtime();
      await withGateway(
        () => {
          throw new Error("unidentified");
        },
        async ({ port, requests }) => {
          await expect(
            action === "login"
              ? modelsAccountsLoginCommand({ port, provider: "openai" }, output)
              : modelsAccountsListCommand({ port }, output),
          ).rejects.toThrow("require a signed-in person");
          expect(requests.map((request) => request.method)).toEqual(["users.self"]);
          expect(mocks.password).not.toHaveBeenCalled();
          expect(mocks.openUrl).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("sends a hidden Claude token only to the person's Gateway and reports metadata", async () => {
    const token = `sk-ant-oat01-${"synthetic".repeat(10)}`;
    const output = runtime();
    await withGateway(
      (request) =>
        request.method === "users.authConnect.token"
          ? { authProfileId: ACCOUNT_ID, links: [] }
          : undefined,
      async ({ port, url, requests, connections }) => {
        mocks.password.mockImplementation(async () => {
          expectPersonalContext(output, url);
          return token;
        });
        await modelsAccountsLoginCommand({ port, provider: "anthropic", json: true }, output);
        expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
          { method: "users.self", params: {} },
          {
            method: "users.authConnect.token",
            params: { profileId: PROFILE_ID, provider: "anthropic", token },
          },
        ]);
        expect(connections).toHaveLength(1);
        expect(mocks.password).toHaveBeenCalledWith(
          expect.objectContaining({ mask: "", output: process.stderr, input: process.stdin }),
        );
        expectJsonOutput(output, {
          profileId: PROFILE_ID,
          provider: "anthropic",
          status: "connected",
          authProfileId: ACCOUNT_ID,
          links: [],
        });
        expect(
          JSON.stringify([
            output.log.mock.calls,
            output.error.mock.calls,
            output.writeJson.mock.calls,
          ]),
        ).not.toContain(token);
      },
    );
  });

  it.each(["openai", "anthropic"])(
    "rejects non-TTY %s sign-in without consuming input",
    async (provider) => {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
      await expect(modelsAccountsLoginCommand({ provider }, runtime())).rejects.toThrow(
        "requires an interactive terminal",
      );
      expect(mocks.password).not.toHaveBeenCalled();
      expect(mocks.openUrl).not.toHaveBeenCalled();
    },
  );

  it("keeps one socket from OAuth start through hidden redirect completion", async () => {
    const redirectInput =
      "http://localhost:1455/auth/callback?code=synthetic-private-code&state=synthetic-state";
    mocks.password.mockResolvedValue(redirectInput);
    const output = runtime();
    await withGateway(
      ({ method }) => {
        if (method === "users.authConnect.start") {
          return startResult();
        }
        if (method === "users.authConnect.status") {
          return { status: "pending" };
        }
        if (method === "users.authConnect.complete") {
          return connected;
        }
        return undefined;
      },
      async ({ port, requests, connections }) => {
        await modelsAccountsLoginCommand({ port, provider: "openai", json: true }, output);
        expect(connections).toHaveLength(1);
        expect(new Set(requests.map(({ socket }) => socket)).size).toBe(1);
        expect(
          requests.find(({ method }) => method === "users.authConnect.complete")?.params,
        ).toEqual({ profileId: PROFILE_ID, connectId: "operation-one", redirectInput });
        expect(requests.some(({ method }) => method === "users.authConnect.cancel")).toBe(false);
        expectJsonOutput(output, {
          profileId: PROFILE_ID,
          provider: "openai",
          ...connected,
        });
        expect(
          JSON.stringify([
            output.log.mock.calls,
            output.error.mock.calls,
            output.writeJson.mock.calls,
          ]),
        ).not.toContain("synthetic-private-code");
      },
    );
  });

  it.each([
    { result: connected, exitCode: undefined },
    {
      result: { status: "failed", reason: "exchange" } satisfies UsersAuthConnectStatusResult,
      exitCode: 1,
    },
  ])(
    "finishes from the authoritative $result.status status and closes the prompt",
    async ({ result, exitCode }) => {
      waitForPromptAbort();
      const output = runtime();
      await withGateway(
        ({ method }) =>
          method === "users.authConnect.start"
            ? startResult()
            : method === "users.authConnect.status"
              ? result
              : undefined,
        async ({ port, requests }) => {
          const command = modelsAccountsLoginCommand(
            { port, provider: "openai", json: true },
            output,
          );
          if (exitCode) {
            await expect(command).rejects.toMatchObject({ code: exitCode });
          } else {
            await command;
          }
          expect(mocks.password.mock.calls[0]?.[0].signal?.aborted).toBe(true);
          expect(
            requests.some(
              ({ method }) =>
                method === "users.authConnect.complete" || method === "users.authConnect.cancel",
            ),
          ).toBe(false);
          expectJsonOutput(output, {
            profileId: PROFILE_ID,
            provider: "openai",
            ...result,
          });
        },
      );
    },
  );

  it("waits for exact cancellation acknowledgment before closing the initiating socket", async () => {
    mocks.password.mockResolvedValue(Symbol("cancel"));
    const received = createDeferredCore<Request>();
    const acknowledged = createDeferredCore<UsersAuthConnectStatusResult>();
    const output = runtime();
    await withGateway(
      (request) => {
        if (request.method === "users.authConnect.start") {
          return startResult();
        }
        if (request.method === "users.authConnect.status") {
          return { status: "pending" };
        }
        if (request.method === "users.authConnect.cancel") {
          received.resolve(request);
          return acknowledged.promise;
        }
        return undefined;
      },
      async ({ port, connections }) => {
        const command = expect(
          modelsAccountsLoginCommand({ port, provider: "openai" }, output),
        ).rejects.toMatchObject({ code: 130 });
        const request = await received.promise;
        expect(request.params).toEqual({ profileId: PROFILE_ID, connectId: "operation-one" });
        expect(request.socket.readyState).toBe(WebSocket.OPEN);
        expect(output.log).not.toHaveBeenCalled();
        acknowledged.resolve({ status: "cancelled" });
        await command;
        expect(connections).toHaveLength(1);
      },
    );
  });

  it("cancels a late start response after Ctrl-C instead of orphaning its operation id", async () => {
    const started = createDeferredCore();
    const response = createDeferredCore<UsersAuthConnectStartResult>();
    const onSignal = vi.spyOn(process, "once");
    await withGateway(
      ({ method }) => {
        if (method === "users.authConnect.start") {
          started.resolve();
          return response.promise;
        }
        if (method === "users.authConnect.cancel") {
          return { status: "cancelled" };
        }
        return undefined;
      },
      async ({ port, requests, connections }) => {
        const command = expect(
          modelsAccountsLoginCommand({ port, provider: "openai" }, runtime()),
        ).rejects.toMatchObject({ code: 130 });
        await started.promise;
        const interrupt = onSignal.mock.calls.find(([event]) => event === "SIGINT")?.[1];
        if (!interrupt) {
          throw new Error("Expected the command's signal handler.");
        }
        interrupt("SIGINT");
        response.resolve(startResult());
        await command;
        expect(requests.map(({ method }) => method)).toEqual([
          "users.self",
          "users.authConnect.start",
          "users.authConnect.cancel",
        ]);
        expect(requests.at(-1)?.params).toEqual({
          profileId: PROFILE_ID,
          connectId: "operation-one",
        });
        expect(connections).toHaveLength(1);
        expect(mocks.password).not.toHaveBeenCalled();
        expect(mocks.openUrl).not.toHaveBeenCalled();
      },
    );
  });

  it("stops on connection loss and never carries the operation to another socket", async () => {
    waitForPromptAbort();
    await withGateway(
      ({ method, socket }) => {
        if (method === "users.authConnect.start") {
          return startResult();
        }
        if (method === "users.authConnect.status") {
          socket.close(1001, "gone");
        }
        return undefined;
      },
      async ({ port, requests, connections }) => {
        await expect(
          modelsAccountsLoginCommand({ port, provider: "openai" }, runtime()),
        ).rejects.toThrow("Could not confirm sign-in cancellation");
        expect(connections).toHaveLength(1);
        expect(new Set(requests.map(({ socket }) => socket)).size).toBe(1);
        expect(mocks.password.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      },
    );
  });
});
