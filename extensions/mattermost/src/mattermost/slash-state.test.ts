// Mattermost tests cover slash state plugin behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
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
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  process.nextTick(() => {
    req.end(body);
  });
  return req;
}

function createResponse(): { res: ServerResponse; getBody: () => string } {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string | Buffer) {
      body = chunk ? String(chunk) : "";
    },
  } as unknown as ServerResponse;
  return { res, getBody: () => body };
}

async function routeSlashRequest(params: {
  body: string;
  register?: typeof registerSlashCommandRoute;
}): Promise<{ statusCode: number; body: string; warn: ReturnType<typeof vi.fn> }> {
  let routeHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const warn = vi.fn();
  (params.register ?? registerSlashCommandRoute)({
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
  const response = createResponse();
  await routeHandler(createRequest(params.body), response.res);
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
