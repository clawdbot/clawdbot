import http from "node:http";
import type { AddressInfo } from "node:net";

const DIRECT_IMAGE_BYTES = Buffer.from("docker-direct-image");
const CODEX_IMAGE_BYTES = Buffer.from("docker-codex-image");
const DIRECT_TOKEN = "sk-openclaw-image-auth-e2e";
const CODEX_TOKEN = "docker-codex-oauth-token";

type RequestRecord = {
  method?: string;
  url?: string;
  authorization?: string;
  accept?: string;
  contentType?: string;
  body: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeCodexSse(res: http.ServerResponse): void {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        result: CODEX_IMAGE_BYTES.toString("base64"),
        revised_prompt: "docker codex revised prompt",
      },
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        tool_usage: { image_gen: { total_tokens: 3 } },
      },
    },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

async function startMockServer(records: RequestRecord[]): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        accept: req.headers.accept,
        contentType: req.headers["content-type"],
        body,
      });

      if (req.method === "POST" && req.url === "/v1/images/generations") {
        assert(
          req.headers.authorization === `Bearer ${DIRECT_TOKEN}`,
          `direct image route used wrong auth: ${req.headers.authorization}`,
        );
        const parsed = JSON.parse(body) as { model?: string; prompt?: string; size?: string };
        assert(parsed.model === "gpt-image-2", `direct route model mismatch: ${body}`);
        assert(
          parsed.prompt === "docker direct image auth",
          `direct route prompt mismatch: ${body}`,
        );
        assert(parsed.size === "1024x1024", `direct route size mismatch: ${body}`);
        writeJson(res, 200, {
          data: [
            {
              b64_json: DIRECT_IMAGE_BYTES.toString("base64"),
              revised_prompt: "docker direct revised prompt",
            },
          ],
        });
        return;
      }

      if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
        assert(
          req.headers.authorization === `Bearer ${CODEX_TOKEN}`,
          `codex image route used wrong auth: ${req.headers.authorization}`,
        );
        const parsed = JSON.parse(body) as {
          tools?: Array<{ type?: string; model?: string; size?: string }>;
          input?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
        };
        assert(
          parsed.tools?.[0]?.type === "image_generation" &&
            parsed.tools[0].model === "gpt-image-2" &&
            parsed.tools[0].size === "1024x1024",
          `codex image tool mismatch: ${body}`,
        );
        assert(
          parsed.input?.[0]?.content?.some(
            (entry) =>
              entry.type === "input_text" && entry.text === "docker codex oauth image auth",
          ),
          `codex prompt missing: ${body}`,
        );
        writeCodexSse(res);
        return;
      }

      writeJson(res, 404, { error: `unexpected ${req.method} ${req.url}` });
    } catch (error) {
      writeJson(res, 500, { error: String(error instanceof Error ? error.message : error) });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function createCodexOAuthStore() {
  return {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: CODEX_TOKEN,
        refresh: "docker-codex-refresh-token",
        expires: Date.now() + 60 * 60 * 1000,
      },
    },
  } as const;
}

async function main() {
  assert(
    process.env.OPENAI_API_KEY === DIRECT_TOKEN,
    "Docker lane must expose the direct OpenAI API key",
  );
  const records: RequestRecord[] = [];
  const mock = await startMockServer(records);
  try {
    const { buildOpenAIImageGenerationProvider } =
      await import("../../dist/extensions/openai/image-generation-provider.js");
    const provider = buildOpenAIImageGenerationProvider();

    const directResult = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "docker direct image auth",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: `${mock.baseUrl}/v1`,
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
    });
    assert(
      directResult.images?.[0]?.buffer?.equals(DIRECT_IMAGE_BYTES),
      "direct image route did not return expected bytes",
    );
    assert(
      records.some((entry) => entry.url === "/v1/images/generations"),
      "direct image route was not called",
    );

    records.length = 0;
    const codexResult = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "docker codex oauth image auth",
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              baseUrl: `${mock.baseUrl}/backend-api/codex`,
              api: "openai-codex-responses",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      authStore: createCodexOAuthStore(),
    });
    assert(
      codexResult.images?.[0]?.buffer?.equals(CODEX_IMAGE_BYTES),
      "Codex OAuth image route did not return expected bytes",
    );
    assert(
      records.some((entry) => entry.url === "/backend-api/codex/responses"),
      "Codex OAuth image route was not called",
    );
    assert(
      !records.some((entry) => entry.url === "/v1/images/generations"),
      "Codex OAuth image route fell back to the direct OpenAI API key",
    );

    process.stdout.write(
      JSON.stringify({
        ok: true,
        routes: records.map((entry) => entry.url),
        directBytes: directResult.images[0]?.buffer.length,
        codexBytes: codexResult.images[0]?.buffer.length,
      }) + "\n",
    );
  } finally {
    await mock.close();
  }
}

await main();
