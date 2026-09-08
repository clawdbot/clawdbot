import http from "node:http";

export async function createCustomProviderTestServer(
  respond: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
  registerCleanup: (cleanup: () => Promise<void>) => void,
): Promise<string> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => respond(request, response, Buffer.concat(chunks).toString("utf8")));
  });
  registerCleanup(async () => {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback provider address");
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

export function writeCustomProviderTestResponse(
  response: http.ServerResponse,
  id: string,
  item: Record<string, unknown>,
  usage: { input_tokens: number; output_tokens: number; total_tokens: number },
): void {
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage } },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

export function customProviderTestConfig(params: {
  model: string;
  provider: string;
  baseUrl: string;
  sandbox: "read-only" | "workspace-write";
}): string {
  return [
    `model=${JSON.stringify(params.model)}`,
    'model_provider="openai"',
    'cli_auth_credentials_store="ephemeral"',
    'web_search="disabled"',
    'approval_policy="never"',
    `sandbox_mode=${JSON.stringify(params.sandbox)}`,
    "allow_login_shell=false",
    "[features]",
    "shell_snapshot=false",
    "[analytics]",
    "enabled=false",
    "[feedback]",
    "enabled=false",
    `[model_providers.${params.provider}]`,
    'name="Synthetic prepared provider"',
    `base_url=${JSON.stringify(params.baseUrl)}`,
    'env_key="CODEX_API_KEY"',
    'wire_api="responses"',
    "requires_openai_auth=false",
    "supports_websockets=false",
    "request_max_retries=0",
    "stream_max_retries=0",
  ].join("\n");
}
