// Mattermost tests prove slash admission through the production plugin entry and real HTTP sockets.
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  registerSlashCommandRoute,
} from "./slash-state.js";

type SlashRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

type HeldRequest = {
  socket: Socket;
  statusCode: number | undefined;
  endedByServer: boolean;
  closedByServer: boolean;
};

const CALLBACK_PATH = "/mattermost/slash";
const TOKEN = "boundary-token";

function createRuntime(dispatch: ReturnType<typeof vi.fn>) {
  return {
    channel: {
      commands: {
        shouldHandleTextCommands: () => true,
      },
      inbound: { dispatch },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({ code: "unused" }),
        buildPairingReply: () => "unused",
      },
      routing: {
        resolveAgentRoute: () => ({
          accountId: "default",
          agentId: "main",
          dmScope: "main",
          sessionKey: "agent:main:mattermost:channel:channel-1",
        }),
      },
      text: {
        hasControlCommand: () => false,
        resolveMarkdownTableMode: () => "off",
        resolveTextChunkLimit: () => 4_000,
      },
    },
  };
}

function openHeldRequest(params: { port: number; localAddress: string }): HeldRequest {
  const held: HeldRequest = {
    socket: connect({
      host: "127.0.0.1",
      port: params.port,
      localAddress: params.localAddress,
    }),
    statusCode: undefined,
    endedByServer: false,
    closedByServer: false,
  };
  const chunks: Buffer[] = [];
  held.socket.on("connect", () => {
    held.socket.write(
      [
        `POST ${CALLBACK_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${params.port}`,
        "Content-Type: application/x-www-form-urlencoded",
        "Content-Length: 1",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
  });
  held.socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    const match = Buffer.concat(chunks)
      .toString("latin1")
      .match(/^HTTP\/1\.1 (\d{3})/u);
    held.statusCode = match ? Number(match[1]) : undefined;
  });
  held.socket.on("end", () => {
    held.endedByServer = true;
  });
  held.socket.on("close", () => {
    held.closedByServer = true;
  });
  held.socket.on("error", () => {});
  return held;
}

async function postForm(params: {
  port: number;
  body: string;
  localAddress: string;
}): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: params.port,
        localAddress: params.localAddress,
        path: CALLBACK_PATH,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(params.body),
          connection: "close",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(params.body);
  });
}

describe("Mattermost slash HTTP boundary", () => {
  afterEach(() => {
    deactivateSlashCommands();
  });

  it("bounds pre-auth bodies at the registered route, closes overflow, and recovers", async () => {
    const routes = new Map<string, SlashRouteHandler>();
    const registrations: Array<{ path: string; auth: string | undefined }> = [];
    const dispatch = vi.fn(async (_params: unknown) => undefined);
    const registerHttpRoute = (route: {
      path: string;
      auth?: string;
      handler: SlashRouteHandler;
    }) => {
      registrations.push({ path: route.path, auth: route.auth });
      routes.set(route.path, route.handler);
    };

    setMattermostRuntime(createRuntime(dispatch) as never);
    registerSlashCommandRoute({
      config: {
        channels: {
          mattermost: {
            commands: { native: true, callbackPath: CALLBACK_PATH },
          },
        },
      },
      logger: { warn() {} },
      registerHttpRoute,
    } as never);

    expect(registrations).toContainEqual({ path: CALLBACK_PATH, auth: "plugin" });
    const slashRoute = routes.get(CALLBACK_PATH);
    if (!slashRoute) {
      throw new Error("expected the Mattermost plugin entry to register its slash route");
    }

    let callbackUrl = "";
    const callbackSourceAddresses: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/api/v4/commands/command-1") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "command-1",
            team_id: "team-1",
            trigger: "oc_status",
            method: "P",
            url: callbackUrl,
            token: TOKEN,
            delete_at: 0,
          }),
        );
        return;
      }
      if (req.url === "/api/v4/channels/channel-1") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "channel-1",
            name: "town-square",
            display_name: "Town Square",
            type: "O",
            team_id: "team-1",
          }),
        );
        return;
      }
      if (req.url === CALLBACK_PATH) {
        callbackSourceAddresses.push(req.socket.remoteAddress ?? "unknown");
        void slashRoute(req, res).catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      res.statusCode = 404;
      res.end("Not Found");
    });

    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected the Mattermost boundary server to have a TCP address");
      }
      callbackUrl = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;

      const account: ResolvedMattermostAccount = {
        accountId: "default",
        enabled: true,
        botToken: "bot-token",
        botTokenSource: "config",
        baseUrl: `http://127.0.0.1:${address.port}`,
        baseUrlSource: "config",
        streamingMode: "partial",
        config: {
          groupPolicy: "open",
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      };
      const command: MattermostRegisteredCommand = {
        id: "command-1",
        teamId: "team-1",
        trigger: "oc_status",
        token: TOKEN,
        url: callbackUrl,
        managed: false,
      };
      activateSlashCommands({
        account,
        commandTokens: [TOKEN],
        registeredCommands: [command],
        api: { cfg: {}, runtime: { log() {}, error() {}, exit() {} } },
      });

      const held = Array.from({ length: 12 }, (_, index) =>
        openHeldRequest({
          port: address.port,
          localAddress: `127.0.0.${index + 2}`,
        }),
      );

      await vi.waitFor(
        () => {
          expect(held.filter((entry) => entry.statusCode === 429)).toHaveLength(4);
        },
        { timeout: 3_000 },
      );
      const overflow = held.filter((entry) => entry.statusCode === 429);
      const admitted = held.filter((entry) => entry.statusCode === undefined);
      expect(admitted).toHaveLength(8);
      expect(callbackSourceAddresses).toHaveLength(12);
      expect(new Set(callbackSourceAddresses).size).toBe(12);
      await vi.waitFor(
        () => {
          expect(overflow.every((entry) => entry.endedByServer && entry.closedByServer)).toBe(true);
        },
        { timeout: 3_000 },
      );

      for (const entry of admitted) {
        entry.socket.write("x");
      }
      await vi.waitFor(
        () => {
          expect(admitted.every((entry) => entry.statusCode === 400)).toBe(true);
        },
        { timeout: 3_000 },
      );

      const recovered = await postForm({
        port: address.port,
        body: "x",
        localAddress: "127.0.0.20",
      });
      expect(recovered.statusCode).toBe(400);

      const validBody = new URLSearchParams({
        token: TOKEN,
        team_id: "team-1",
        channel_id: "channel-1",
        user_id: "user-1",
        user_name: "boundary-user",
        command: "/oc_status",
        text: "hello",
        trigger_id: "trigger-1",
      }).toString();
      const valid = await postForm({
        port: address.port,
        body: validBody,
        localAddress: "127.0.0.21",
      });
      expect(valid).toEqual({
        statusCode: 200,
        body: JSON.stringify({ response_type: "ephemeral", text: "Processing..." }),
      });
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        channel: "mattermost",
        accountId: "default",
        ctxPayload: {
          Body: "/status hello",
          SenderId: "user-1",
          InboundAccessAuthorized: true,
        },
      });
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 15_000);
});
