import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { listToolsTolerant } from "./mcp-list-tools-tolerant.js";

// A root-level `oneOf` is legal JSON Schema 2020-12 and describes an object, but
// carries no top-level "type" -- the shape the SDK's ToolSchema rejects (#112667).
const ONE_OF_TOOL = {
  name: "finlynq_query",
  description: "Look a security up by symbol or by ISIN",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      { type: "object", properties: { isin: { type: "string" } }, required: ["isin"] },
    ],
  },
} as unknown as Tool;

const CONFORMING_TOOL = {
  name: "finlynq_ping",
  description: "Health check",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as unknown as Tool;

async function connectClient(
  handler: (params: { cursor?: string }) => Promise<{ tools: Tool[]; nextCursor?: string }>,
) {
  const server = new Server({ name: "finlynq", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    handler({ cursor: request.params?.cursor }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "openclaw-test", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("listToolsTolerant (#112667)", () => {
  it("loads a server whose tool inputSchema is a root-level oneOf", async () => {
    const { client, close } = await connectClient(async () => ({ tools: [ONE_OF_TOOL] }));
    try {
      // The SDK's own strict schema is what fails today -- this is the bug.
      await expect(client.listTools()).rejects.toThrow();

      const page = await listToolsTolerant(client);
      expect(page.tools.map((tool) => tool.name)).toEqual(["finlynq_query"]);
    } finally {
      await close();
    }
  });

  it("keeps the conforming tools on a server that also advertises a oneOf tool", async () => {
    const { client, close } = await connectClient(async () => ({
      tools: [ONE_OF_TOOL, CONFORMING_TOOL],
    }));
    try {
      const page = await listToolsTolerant(client);
      expect(page.tools.map((tool) => tool.name)).toEqual(["finlynq_query", "finlynq_ping"]);
    } finally {
      await close();
    }
  });

  it("passes the advertised schema through verbatim", async () => {
    const { client, close } = await connectClient(async () => ({ tools: [ONE_OF_TOOL] }));
    try {
      const page = await listToolsTolerant(client);
      expect(page.tools[0]?.inputSchema).toEqual(ONE_OF_TOOL.inputSchema);
      expect(page.tools[0]?.description).toBe("Look a security up by symbol or by ISIN");
    } finally {
      await close();
    }
  });

  it("leaves a conforming server on the strict SDK path (one request, no retry)", async () => {
    let requests = 0;
    const { client, close } = await connectClient(async () => {
      requests += 1;
      return { tools: [CONFORMING_TOOL] };
    });
    try {
      const page = await listToolsTolerant(client);
      expect(page.tools.map((tool) => tool.name)).toEqual(["finlynq_ping"]);
      expect(requests).toBe(1);
    } finally {
      await close();
    }
  });

  it("forwards the cursor and returns nextCursor", async () => {
    const seen: Array<string | undefined> = [];
    const { client, close } = await connectClient(async ({ cursor }) => {
      seen.push(cursor);
      return cursor ? { tools: [CONFORMING_TOOL] } : { tools: [ONE_OF_TOOL], nextCursor: "page-2" };
    });
    try {
      const first = await listToolsTolerant(client);
      expect(first.nextCursor).toBe("page-2");
      const second = await listToolsTolerant(client, { cursor: first.nextCursor });
      expect(second.tools.map((tool) => tool.name)).toEqual(["finlynq_ping"]);
      // The relaxed retry re-issues the same page, so the first cursor appears twice.
      expect(seen).toEqual([undefined, undefined, "page-2"]);
    } finally {
      await close();
    }
  });

  it("still rejects a tool schema that declares a non-object type", async () => {
    const arrayTool = {
      name: "finlynq_batch",
      inputSchema: { type: "array", items: { type: "number" } },
    } as unknown as Tool;
    const { client, close } = await connectClient(async () => ({ tools: [arrayTool] }));
    try {
      // Not a missing root type -- a wrong one. The server stays rejected, with the
      // same diagnostic the strict schema produces today.
      await expect(listToolsTolerant(client)).rejects.toThrow(/Invalid input: expected/);
    } finally {
      await close();
    }
  });

  it("does not retry a response that is malformed beyond the schema type", async () => {
    let requests = 0;
    const { client, close } = await connectClient(async () => {
      requests += 1;
      // Not a schema with an unstated type -- not a schema object at all.
      return { tools: [{ name: "finlynq_broken", inputSchema: [] } as unknown as Tool] };
    });
    try {
      await expect(listToolsTolerant(client)).rejects.toThrow(/Invalid input/);
      // One request: a server answering differently on a retry must not be able to
      // turn a rejected catalog into an accepted one.
      expect(requests).toBe(1);
    } finally {
      await close();
    }
  });

  it("rethrows server-side failures instead of retrying them", async () => {
    const { client, close } = await connectClient(async () => {
      throw new Error("tools/list exploded");
    });
    try {
      await expect(listToolsTolerant(client)).rejects.toThrow(/exploded/);
    } finally {
      await close();
    }
  });

  it("rethrows when the client cannot issue a raw request", async () => {
    const validationError = Object.assign(new Error("bad tool schema"), {
      issues: [{ path: ["tools", 0, "inputSchema", "type"] }],
    });
    const client = {
      listTools: async () => {
        throw validationError;
      },
    };
    await expect(listToolsTolerant(client)).rejects.toBe(validationError);
  });
});
