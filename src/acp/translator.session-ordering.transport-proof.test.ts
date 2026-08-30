import { PassThrough, Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
/** Boundary-level transport proof: uses real ACP SDK transport
 * (AgentSideConnection + ClientSideConnection + ndJsonStream over PassThrough
 * streams) with a mock Gateway to prove the JSON-RPC response reaches the wire
 * before any session/update notification. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp session ordering transport proof", () => {
  it("newSession response precedes session/update notification over real ACP transport", async () => {
    const agentToClient = new PassThrough();
    const clientToAgent = new PassThrough();

    const agentStream = ndJsonStream(
      Writable.toWeb(agentToClient),
      Readable.toWeb(clientToAgent) as ReadableStream<Uint8Array>,
    );
    const clientStream = ndJsonStream(
      Writable.toWeb(clientToAgent),
      Readable.toWeb(agentToClient) as ReadableStream<Uint8Array>,
    );

    const sessionStore = createInMemorySessionStore();
    let agent: AcpGatewayAgent;
    const connection = new AgentSideConnection(
      ((conn: AgentSideConnection) => {
        agent = new AcpGatewayAgent(conn, createAcpGateway(), { sessionStore });
        agent.start();
        return agent;
      }) as () => AcpGatewayAgent,
      agentStream,
    );
    void connection;

    const events: string[] = [];
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {
          events.push("notification");
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      clientStream,
    );

    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "transport-proof-client", version: "1.0.0" },
    });

    await client.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: {},
    });
    events.push("response");

    // The response must arrive before any notification.
    expect(events[0]).toBe("response");

    // Allow deferred notifications to fire.
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(events).toContain("notification");
    expect(events.indexOf("response")).toBeLessThan(events.indexOf("notification"));

    // Clean up.
    agent!.shutdown();
    agentToClient.destroy();
    clientToAgent.destroy();
  });
});
