// Mattermost tests cover slash state plugin behavior.
import { EventEmitter } from "node:events";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createMockIncomingRequest, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  registerSlashCommandRoute,
} from "./slash-state.js";

function createResolvedMattermostAccount(accountId: string): ResolvedMattermostAccount {
  return {
    accountId,
    enabled: true,
    botTokenSource: "config",
    baseUrlSource: "config",
    streamingMode: "partial",
    config: {},
  };
}

function createRegisteredCommand(params?: {
  id?: string;
  teamId?: string;
  trigger?: string;
}): MattermostRegisteredCommand {
  return {
    id: params?.id ?? "cmd-1",
    teamId: params?.teamId ?? "team-1",
    trigger: params?.trigger ?? "oc_status",
    token: "token-1",
    url: "https://gateway.example.com/slash",
    managed: false,
  };
}

const slashApi = {
  cfg: {},
  runtime: {
    log: () => {},
    error: () => {},
    exit: () => {},
  },
} satisfies {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
};

const ACCOUNT_STATES_KEY = Symbol.for("openclaw.mattermost.slash-account-states");

type AccountState = {
  handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null;
};

function getAccountStates(): Map<string, AccountState> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const states = globalStore[ACCOUNT_STATES_KEY];
  if (!(states instanceof Map)) {
    throw new Error("expected Mattermost slash account state map");
  }
  return states as Map<string, AccountState>;
}

function replaceAccountHandler(accountId: string): void {
  const state = getAccountStates().get(accountId);
  if (!state) {
    throw new Error(`expected Mattermost slash state for ${accountId}`);
  }
  state.handler = async (_req, res) => {
    res.statusCode = 200;
    res.end(accountId);
  };
}

function createRequest(body: string): IncomingMessage {
  const req = createMockIncomingRequest([body]);
  req.method = "POST";
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  return req;
}

function createStalledRequest(remoteAddress: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress });
  return req;
}

function createResponse(): { res: ServerResponse; getBody: () => string } {
  let body = "";
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader() {},
    removeHeader() {},
    end(chunk?: string | Buffer, callback?: () => void) {
      body = chunk ? String(chunk) : "";
      callback?.();
    },
  }) as unknown as ServerResponse;
  return { res, getBody: () => body };
}

function createSlashRoute(register = registerSlashCommandRoute) {
  let routeHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const warn = vi.fn();
  register({
    config: { channels: { mattermost: {} } },
    logger: { warn },
    registerHttpRoute(route: {
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    }) {
      routeHandler = route.handler;
    },
  } as never);
  if (!routeHandler) {
    throw new Error("expected Mattermost slash route registration");
  }
  return { handler: routeHandler, warn };
}

async function routeSlashRequest(params: {
  body: string;
  register?: typeof registerSlashCommandRoute;
}): Promise<{ statusCode: number; body: string; warn: ReturnType<typeof vi.fn> }> {
  const { handler, warn } = createSlashRoute(params.register);
  const response = createResponse();
  await handler(createRequest(params.body), response.res);
  return { statusCode: response.res.statusCode, body: response.getBody(), warn };
}

function activate(params: {
  accountId: string;
  tokens: string[];
  commands?: MattermostRegisteredCommand[];
}): void {
  activateSlashCommands({
    account: createResolvedMattermostAccount(params.accountId),
    commandTokens: params.tokens,
    registeredCommands: params.commands ?? [],
    api: slashApi,
  });
  replaceAccountHandler(params.accountId);
}

describe("slash-state global singleton", () => {
  afterEach(() => {
    deactivateSlashCommands();
  });

  it("anchors accountStates on globalThis", () => {
    activate({ accountId: "a1", tokens: ["tok-a"] });
    expect(getAccountStates().has("a1")).toBe(true);
  });

  it("preserves slash routing state across module reloads", async () => {
    activate({ accountId: "a1", tokens: ["tok-reload"] });
    activate({ accountId: "a2", tokens: ["tok-other"] });

    vi.resetModules();
    const reloaded = await import("./slash-state.js");
    const result = await routeSlashRequest({
      register: reloaded.registerSlashCommandRoute,
      body: "token=tok-reload",
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("a1");
  });
});

describe("slash-state request routing", () => {
  afterEach(() => {
    deactivateSlashCommands();
  });

  it.each([
    {
      name: "token match",
      body: "token=token-1",
      status: 400,
      message: "Invalid slash command payload.",
    },
    {
      name: "registered command match",
      body: "token=rotated&team_id=team-1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
      status: 401,
      message: "Unauthorized: invalid command token.",
    },
  ])("keeps real multi-account $name requests in account validation", async (testCase) => {
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      commandTokens: ["token-1"],
      registeredCommands: [createRegisteredCommand()],
      api: slashApi,
    });
    activateSlashCommands({
      account: createResolvedMattermostAccount("a2"),
      commandTokens: ["token-2"],
      registeredCommands: [createRegisteredCommand({ id: "cmd-2", teamId: "team-2" })],
      api: slashApi,
    });
    const route = createSlashRoute();
    await withServer(
      (req, res) => {
        void route.handler(req, res).catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/slash`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: testCase.body,
        });
        expect(response.status).toBe(testCase.status);
        expect(await response.json()).toEqual({
          response_type: "ephemeral",
          text: testCase.message,
        });
      },
    );
  });

  it("bounds concurrent pre-authentication body reads across the slash route", async () => {
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      commandTokens: ["token-1"],
      registeredCommands: [createRegisteredCommand()],
      api: slashApi,
    });
    const route = createSlashRoute();
    const requests = Array.from({ length: 12 }, (_, index) =>
      createStalledRequest(`203.0.113.${index + 1}`),
    );
    const responses = requests.map(() => createResponse());
    const runs = requests.map((req, index) => route.handler(req, responses[index]!.res));

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(responses.filter(({ res }) => res.statusCode === 200)).toHaveLength(8);
      expect(responses.filter(({ res }) => res.statusCode === 429)).toHaveLength(4);
    } finally {
      for (const req of requests) {
        req.complete = true;
        req.push(null);
      }
      await Promise.all(runs);
    }

    const followUp = createResponse();
    await route.handler(createRequest(""), followUp.res);
    expect(followUp.res.statusCode).toBe(400);
  });

  it("routes a token owned by one account", async () => {
    activate({ accountId: "a1", tokens: ["tok-a"] });
    activate({ accountId: "a2", tokens: ["tok-b"] });

    const result = await routeSlashRequest({ body: "token=tok-a" });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("a1");
  });

  it("rejects a token shared by multiple accounts", async () => {
    activate({ accountId: "a1", tokens: ["tok-shared"] });
    activate({ accountId: "a2", tokens: ["tok-shared"] });

    const result = await routeSlashRequest({ body: "token=tok-shared" });

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain("command token is not unique");
    expect(result.warn).toHaveBeenCalledWith(
      "mattermost: slash callback matched multiple accounts via token (a1, a2)",
    );
  });

  it("routes by registered team and command when token lookup misses", async () => {
    activate({
      accountId: "a1",
      tokens: ["old-token"],
      commands: [createRegisteredCommand()],
    });
    activate({
      accountId: "a2",
      tokens: ["other-token"],
      commands: [createRegisteredCommand({ id: "cmd-2", teamId: "team-2" })],
    });

    const result = await routeSlashRequest({
      body: "token=rotated&team_id=team-1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("a1");
  });

  it("rejects a registered team and command shared by multiple accounts", async () => {
    activate({
      accountId: "a1",
      tokens: ["tok-a"],
      commands: [createRegisteredCommand({ id: "cmd-a" })],
    });
    activate({
      accountId: "a2",
      tokens: ["tok-b"],
      commands: [createRegisteredCommand({ id: "cmd-b" })],
    });

    const result = await routeSlashRequest({
      body: "token=rotated&team_id=team-1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
    });

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain("slash command is not unique");
    expect(result.warn).toHaveBeenCalledWith(
      "mattermost: slash callback matched multiple accounts via command (a1, a2)",
    );
  });
});
