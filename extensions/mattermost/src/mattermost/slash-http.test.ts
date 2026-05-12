import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostClient } from "./client.js";
import {
  MATTERMOST_SLASH_POST_METHOD,
  type MattermostCommandResponse,
  type MattermostRegisteredCommand,
} from "./slash-commands.js";
import {
  createSlashCommandHttpHandler,
  resetMattermostSlashCommandValidationCacheForTests,
  validateMattermostSlashCommandToken,
} from "./slash-http.js";

function createRequest(params: {
  method?: string;
  body?: string;
  contentType?: string;
  autoEnd?: boolean;
}): IncomingMessage {
  const req = new PassThrough();
  const incoming = req as PassThrough & IncomingMessage;
  incoming.method = params.method ?? "POST";
  incoming.headers = {
    "content-type": params.contentType ?? "application/x-www-form-urlencoded",
  };
  process.nextTick(() => {
    if (params.body) {
      req.write(params.body);
    }
    if (params.autoEnd !== false) {
      req.end();
    }
  });
  return incoming;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
  getHeaders: () => Map<string, string>;
} {
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string | Buffer) {
      body = chunk ? String(chunk) : "";
    },
  } as ServerResponse;
  return {
    res,
    getBody: () => body,
    getHeaders: () => headers,
  };
}

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  streamingMode: "partial",
  config: {},
};

function createRegisteredCommand(params?: {
  token?: string;
  teamId?: string;
  trigger?: string;
  url?: string;
}): MattermostRegisteredCommand {
  return {
    id: "cmd-1",
    teamId: params?.teamId ?? "t1",
    trigger: params?.trigger ?? "oc_status",
    token: params?.token ?? "valid-token",
    url: params?.url ?? "https://gateway.example.com/slash",
    managed: false,
  };
}

function createCommandLookupClient(params: {
  command?: MattermostCommandResponse | null | (() => MattermostCommandResponse | null);
  commandLookupError?: Error;
  listLookupError?: Error;
  listCommands?: MattermostCommandResponse[];
}): MattermostClient & { requests: string[] } {
  const requests: string[] = [];
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "bot-token",
    request: async <T>(path: string) => {
      requests.push(path);
      if (path === "/commands/cmd-1") {
        if (params.commandLookupError) {
          throw params.commandLookupError;
        }
        const command = typeof params.command === "function" ? params.command() : params.command;
        if (command) {
          return command as T;
        }
        throw new Error("not found");
      }
      if (path.startsWith("/commands?team_id=")) {
        if (params.listLookupError) {
          throw params.listLookupError;
        }
        const command = typeof params.command === "function" ? params.command() : params.command;
        return (params.listCommands ?? (command ? [command] : [])) as T;
      }
      throw new Error(`unexpected request path: ${path}`);
    },
    fetchImpl: vi.fn<typeof fetch>(),
    requests,
  };
}

async function runSlashRequest(params: {
  registeredCommands?: MattermostRegisteredCommand[];
  body: string;
  method?: string;
}) {
  const handler = createSlashCommandHttpHandler({
    account: accountFixture,
    cfg: {} as OpenClawConfig,
    runtime: {} as RuntimeEnv,
    registeredCommands: params.registeredCommands ?? [],
  });
  const req = createRequest({ method: params.method, body: params.body });
  const response = createResponse();
  await handler(req, response.res);
  return response;
}

describe("slash-http", () => {
  beforeEach(() => {
    resetMattermostSlashCommandValidationCacheForTests();
  });

  it("rejects non-POST methods", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [createRegisteredCommand()],
    });
    const req = createRequest({ method: "GET", body: "" });
    const response = createResponse();

    await handler(req, response.res);

    expect(response.res.statusCode).toBe(405);
    expect(response.getBody()).toBe("Method Not Allowed");
    expect(response.getHeaders().get("allow")).toBe("POST");
  });

  it("rejects malformed payloads", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [createRegisteredCommand()],
    });
    const req = createRequest({ body: "token=abc&command=%2Foc_status" });
    const response = createResponse();

    await handler(req, response.res);

    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain("Invalid slash command payload");
  });

  it("fails closed when no commands are registered", async () => {
    const response = await runSlashRequest({
      registeredCommands: [],
      body: "token=tok1&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_status&text=",
    });

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
  });

  it("rejects unknown slash commands before upstream validation", async () => {
    const response = await runSlashRequest({
      registeredCommands: [createRegisteredCommand({ token: "known-token" })],
      body: "token=unknown&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_unknown&text=",
    });

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
  });

  it("rejects a token valid for one command when used against another command", async () => {
    // Cross-command spray DoS guard: a payload pointing at command B with the
    // token for command A must fail at the per-command startup gate, before
    // upstream validation runs and could poison the failure cache for B.
    const response = await runSlashRequest({
      registeredCommands: [
        createRegisteredCommand({ token: "token-status", trigger: "oc_status" }),
        {
          id: "cmd-2",
          teamId: "t1",
          trigger: "oc_help",
          token: "token-help",
          url: "https://gateway.example.com/slash",
          managed: false,
        },
      ],
      body: "token=token-status&team_id=t1&channel_id=c1&user_id=u1&command=%2Foc_help&text=",
    });

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
  });

  it("returns 408 when the request body stalls", async () => {
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [createRegisteredCommand()],
      bodyTimeoutMs: 1,
    });
    const req = createRequest({ autoEnd: false });
    const response = createResponse();

    await handler(req, response.res);

    expect(response.res.statusCode).toBe(408);
    expect(response.getBody()).toBe("Request body timeout");
  });

  it("rejects the startup token when Mattermost has rotated the current command token", async () => {
    const registeredCommand = createRegisteredCommand({ token: "old-token" });
    const client = createCommandLookupClient({
      command: {
        id: "cmd-1",
        token: "new-token",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 0,
      },
    });

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "old-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
      }),
    ).resolves.toBe(false);

    expect(registeredCommand.token).toBe("old-token");
  });

  it("accepts the startup token while the current Mattermost command still matches", async () => {
    const registeredCommand = createRegisteredCommand({ token: "valid-token" });
    const client = createCommandLookupClient({
      command: {
        id: "cmd-1",
        token: "valid-token",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 0,
      },
    });

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "valid-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
      }),
    ).resolves.toBe(true);
  });

  it("rate-limits sequential current-command lookups without caching successes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T00:00:00Z"));
    try {
      const registeredCommand = createRegisteredCommand({ token: "valid-token" });
      const command = {
        id: "cmd-1",
        token: "valid-token",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 0,
      };
      const client = createCommandLookupClient({ command });
      const payload = {
        token: "valid-token",
        team_id: "t1",
        channel_id: "c1",
        user_id: "u1",
        command: "/oc_status",
        text: "",
      };
      const log = vi.fn();

      for (let i = 0; i < 20; i += 1) {
        await expect(
          validateMattermostSlashCommandToken({
            accountId: "default",
            client,
            registeredCommand,
            payload,
            log,
          }),
        ).resolves.toBe(true);
      }
      await expect(
        validateMattermostSlashCommandToken({
          accountId: "default",
          client,
          registeredCommand,
          payload,
          log,
        }),
      ).resolves.toBe(false);

      expect(client.requests).toHaveLength(20);
      expect(log).toHaveBeenCalledWith(
        "mattermost: slash command validation lookup rate-limited for /oc_status",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks matching current commands so startup tokens are not accepted after rotation", async () => {
    const registeredCommand = createRegisteredCommand({ token: "valid-token" });
    let command = {
      id: "cmd-1",
      token: "valid-token",
      team_id: "t1",
      trigger: "oc_status",
      method: MATTERMOST_SLASH_POST_METHOD,
      url: "https://gateway.example.com/slash",
      auto_complete: true,
      delete_at: 0,
    };
    const client = createCommandLookupClient({
      command: () => command,
    });
    const payload = {
      token: "valid-token",
      team_id: "t1",
      channel_id: "c1",
      user_id: "u1",
      command: "/oc_status",
      text: "",
    };

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload,
      }),
    ).resolves.toBe(true);
    command = {
      ...command,
      token: "new-token",
    };
    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload,
      }),
    ).resolves.toBe(false);

    expect(client.requests).toEqual(["/commands/cmd-1", "/commands/cmd-1"]);
  });

  it("briefly caches failed current command validation without accepting stale tokens", async () => {
    const registeredCommand = createRegisteredCommand({ token: "old-token" });
    const client = createCommandLookupClient({
      command: {
        id: "cmd-1",
        token: "new-token",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 0,
      },
    });
    const payload = {
      token: "old-token",
      team_id: "t1",
      channel_id: "c1",
      user_id: "u1",
      command: "/oc_status",
      text: "",
    };

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload,
      }),
    ).resolves.toBe(false);
    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload,
      }),
    ).resolves.toBe(false);

    expect(client.requests).toEqual(["/commands/cmd-1"]);
  });

  it("scopes validation cache entries by account", async () => {
    const registeredCommand = createRegisteredCommand();
    const clientA = createCommandLookupClient({
      command: {
        id: "cmd-1",
        token: "token-a",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 0,
      },
    });
    const clientB = createCommandLookupClient({
      command: {
        id: "cmd-1",
        token: "token-b",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 0,
      },
    });

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "a1",
        client: clientA,
        registeredCommand,
        payload: {
          token: "token-a",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
      }),
    ).resolves.toBe(true);
    await expect(
      validateMattermostSlashCommandToken({
        accountId: "a2",
        client: clientB,
        registeredCommand,
        payload: {
          token: "token-b",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
      }),
    ).resolves.toBe(true);

    expect(clientA.requests).toEqual(["/commands/cmd-1"]);
    expect(clientB.requests).toEqual(["/commands/cmd-1"]);
  });

  it("rejects a command that Mattermost reports as deleted", async () => {
    const registeredCommand = createRegisteredCommand();
    const client = createCommandLookupClient({
      command: {
        id: "cmd-1",
        token: "valid-token",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 123,
      },
    });

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "valid-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
      }),
    ).resolves.toBe(false);
  });

  it("rejects a regenerated command when the current command id changed", async () => {
    const registeredCommand = createRegisteredCommand({ token: "old-token" });
    const oldDeletedCommand = {
      id: "cmd-1",
      token: "old-token",
      team_id: "t1",
      trigger: "oc_status",
      method: MATTERMOST_SLASH_POST_METHOD,
      url: "https://gateway.example.com/slash",
      auto_complete: true,
      delete_at: 123,
    };
    const newCommand = {
      id: "cmd-2",
      token: "new-token",
      team_id: "t1",
      trigger: "oc_status",
      method: MATTERMOST_SLASH_POST_METHOD,
      url: "https://gateway.example.com/slash",
      auto_complete: true,
      delete_at: 0,
    };
    const client = createCommandLookupClient({
      command: oldDeletedCommand,
      listCommands: [oldDeletedCommand, newCommand],
    });

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "new-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
      }),
    ).resolves.toBe(false);
    expect(client.requests).toEqual(["/commands/cmd-1", "/commands?team_id=t1&custom_only=true"]);
  });

  it("logs when command lookup by id returns a deleted command before fallback", async () => {
    const registeredCommand = createRegisteredCommand();
    const command = {
      id: "cmd-1\r\nspoofed",
      token: "valid-token",
      team_id: "t1",
      trigger: "oc_status",
      method: MATTERMOST_SLASH_POST_METHOD,
      url: "https://gateway.example.com/slash",
      auto_complete: true,
      delete_at: 123,
    };
    const client = createCommandLookupClient({
      command,
      listCommands: [],
    });
    const log = vi.fn();

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "valid-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
        log,
      }),
    ).resolves.toBe(false);

    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls.at(0)?.[0] ?? "";
    expect(message).not.toMatch(/[\r\n\t]/u);
    expect(message).toContain("deleted command cmd-1  spoofed");
    expect(message).toContain("using team list fallback");
  });

  it("rejects current commands with a mismatched method or callback URL", async () => {
    const registeredCommand = createRegisteredCommand();

    for (const command of [
      {
        id: "cmd-1",
        token: "valid-token",
        team_id: "t1",
        trigger: "oc_status",
        method: "G",
        url: "https://gateway.example.com/slash",
        auto_complete: true,
        delete_at: 0,
      },
      {
        id: "cmd-1",
        token: "valid-token",
        team_id: "t1",
        trigger: "oc_status",
        method: MATTERMOST_SLASH_POST_METHOD,
        url: "https://gateway.example.com/other",
        auto_complete: true,
        delete_at: 0,
      },
    ]) {
      resetMattermostSlashCommandValidationCacheForTests();
      const client = createCommandLookupClient({ command });

      await expect(
        validateMattermostSlashCommandToken({
          accountId: "default",
          client,
          registeredCommand,
          payload: {
            token: "valid-token",
            team_id: "t1",
            channel_id: "c1",
            user_id: "u1",
            command: "/oc_status",
            text: "",
          },
        }),
      ).resolves.toBe(false);
    }
  });

  it("falls back to the team command list when command lookup is unavailable", async () => {
    const registeredCommand = createRegisteredCommand();
    const command = {
      id: "cmd-1",
      token: "valid-token",
      team_id: "t1",
      trigger: "oc_status",
      method: MATTERMOST_SLASH_POST_METHOD,
      url: "https://gateway.example.com/slash",
      auto_complete: true,
      delete_at: 0,
    };
    const client = createCommandLookupClient({
      commandLookupError: new Error("not implemented"),
      listCommands: [command],
    });

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "valid-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
      }),
    ).resolves.toBe(true);
    expect(client.requests).toEqual(["/commands/cmd-1", "/commands?team_id=t1&custom_only=true"]);
  });

  it("logs sanitized command lookup failures when falling back to the team command list", async () => {
    const registeredCommand = createRegisteredCommand({ trigger: "oc_status\r\nspoofed" });
    const command = {
      id: "cmd-1",
      token: "valid-token",
      team_id: "t1",
      trigger: "oc_status\r\nspoofed",
      method: MATTERMOST_SLASH_POST_METHOD,
      url: "https://gateway.example.com/slash",
      auto_complete: true,
      delete_at: 0,
    };
    const client = createCommandLookupClient({
      commandLookupError: new Error(
        "primary\ntoken=secret-token https://user:pass@chat.example.com/api?access_token=secret-access&client_secret=secret-client",
      ),
      listCommands: [command],
    });
    const log = vi.fn();

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "valid-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
        log,
      }),
    ).resolves.toBe(true);

    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls.at(0)?.[0] ?? "";
    expect(message).not.toMatch(/[\r\n\t]/u);
    expect(message).toContain("/oc_status  spoofed");
    expect(message).toContain("primary token=[redacted]");
    expect(message).toContain("https://redacted:redacted@chat.example.com/api");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("secret-access");
    expect(message).not.toContain("secret-client");
    expect(message).not.toContain("user:pass");
  });

  it("sanitizes upstream lookup errors before logging fallback failures", async () => {
    const registeredCommand = createRegisteredCommand();
    const client = createCommandLookupClient({
      commandLookupError: new Error('primary\ntoken=secret-token refresh_token="secret-refresh"'),
      listLookupError: new Error(
        "fallback\r\nsecond-line botToken: secret-bot https://user:pass@chat.example.com/hooks?token=secret-query",
      ),
    });
    const log = vi.fn();

    await expect(
      validateMattermostSlashCommandToken({
        accountId: "default",
        client,
        registeredCommand,
        payload: {
          token: "valid-token",
          team_id: "t1",
          channel_id: "c1",
          user_id: "u1",
          command: "/oc_status",
          text: "",
        },
        log,
      }),
    ).resolves.toBe(false);

    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls.at(0)?.[0] ?? "";
    expect(message).not.toMatch(/[\r\n\t]/u);
    expect(message).toContain("fallback  second-line");
    expect(message).toContain("botToken: [redacted]");
    expect(message).toContain("https://redacted:redacted@chat.example.com/hooks");
    expect(message).toContain("primary token=[redacted]");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("secret-refresh");
    expect(message).not.toContain("secret-bot");
    expect(message).not.toContain("secret-query");
    expect(message).not.toContain("user:pass");
  });
});
