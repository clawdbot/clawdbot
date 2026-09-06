import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const activeHttpServers = new Set<http.Server>();

export async function startPolicyHttpServer(): Promise<string> {
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) {
        response.writeHead(202).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: string | number;
        method?: string;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "policy-http-probe", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  { name: "read_docs", description: "read", inputSchema: { type: "object" } },
                ],
              }
            : {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  activeHttpServers.add(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback MCP server address");
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

export async function writePolicyProbeServer(dir: string): Promise<string> {
  const filePath = path.join(dir, "policy-probe.mjs");
  await fs.writeFile(
    filePath,
    `import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.env.OPENCLAW_POLICY_PROBE_STARTED) appendFileSync(process.env.OPENCLAW_POLICY_PROBE_STARTED, "started\\n");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "policy-probe", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [
    { name: "read_docs", description: "read", inputSchema: { type: "object" } },
    { name: "delete_docs", description: "delete", inputSchema: { type: "object" } },
    { name: "task_docs", description: "task", inputSchema: { type: "object" }, execution: { taskSupport: "required" } },
    { name: "app_docs", description: "app", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }
  ] });
});
`,
    "utf-8",
  );
  return filePath;
}

export async function closePolicyHttpServers(): Promise<void> {
  await Promise.all(
    [...activeHttpServers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  activeHttpServers.clear();
}
