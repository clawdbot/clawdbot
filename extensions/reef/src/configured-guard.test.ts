import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGuardBaseUrl } from "../protocol/guard-endpoint.js";
import { createAnthropicGuard, createOpenAiGuard, type GuardRequest } from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { createConfiguredGuard } from "./configured-guard.js";

const request: GuardRequest = {
  direction: "outbound",
  source: "alice#1",
  destination: "bob#1",
  text: "hello",
  policyVersion: "v1",
};
const guard = {
  provider: "openai" as const,
  pinnedModel: "gpt-5.6-terra",
  policyVersion: "v1",
  timeoutMs: 5_000,
};
const verdict = {
  decision: "allow",
  category: "ordinary",
  reason: "Ordinary discussion",
  policyVersion: "v1",
};
const response = (model = guard.pinnedModel, decision = "allow") => ({
  model,
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify({ ...verdict, decision }) }],
    },
  ],
});
const servers: Server[] = [];
const directories: string[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture address");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("configured Reef guard", () => {
  it("routes through an actual loopback broker with explicit medium reasoning and marker", async () => {
    const seen: { url?: string; auth?: string; body?: unknown } = {};
    const baseUrl = await listen(
      createServer((incoming, outgoing) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) {
            chunks.push(Buffer.from(chunk));
          }
          seen.url = incoming.url;
          seen.auth = incoming.headers.authorization;
          seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify(response()));
        })().catch(() => outgoing.destroy());
      }),
    );
    const adapter = await createConfiguredGuard(
      ReefChannelConfigSchema.parse({
        guard: {
          ...guard,
          baseUrl: `${baseUrl}/v1/`,
          apiKey: "broker-marker",
          reasoningEffort: "medium",
          rules: { outbound: "Allow sanitized diagnostic workflow envelopes." },
        },
      }),
    );
    await expect(adapter.classify(request)).resolves.toEqual({
      ...verdict,
      model: guard.pinnedModel,
    });
    expect(seen).toMatchObject({
      url: "/v1/responses",
      auth: "Bearer broker-marker",
      body: {
        model: guard.pinnedModel,
        reasoning: { effort: "medium" },
        store: false,
        background: false,
        tools: [],
        instructions: expect.stringContaining("Allow sanitized diagnostic workflow envelopes."),
      },
    });
  });

  it("resolves a protected file SecretRef through the canonical provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reef-guard-secret-"));
    directories.push(directory);
    const path = join(directory, "credential");
    await writeFile(path, " test-file-key \n", { mode: 0o600 });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
    const adapter = await createConfiguredGuard(
      ReefChannelConfigSchema.parse({
        guard: {
          ...guard,
          apiKey: { source: "file", provider: "guard", id: "value" },
        },
      }),
      fetcher,
      { secrets: { providers: { guard: { source: "file", path, mode: "singleValue" } } } },
    );
    await expect(adapter.classify(request)).resolves.toMatchObject({ decision: "allow" });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer test-file-key",
    );
  });

  it("resolves env SecretRefs and preserves legacy env configuration defaults", async () => {
    vi.stubEnv("REEF_TEST_GUARD", " test-env-key ");
    for (const credential of [
      { apiKeyEnv: "REEF_TEST_GUARD" },
      { apiKey: { source: "env", provider: "default", id: "REEF_TEST_GUARD" } },
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
      const adapter = await createConfiguredGuard(
        ReefChannelConfigSchema.parse({ guard: { ...guard, ...credential } }),
        fetcher,
      );
      await adapter.classify(request);
      expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
      const init = fetcher.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-env-key");
      if (typeof init?.body !== "string") {
        throw new Error("Expected JSON request body");
      }
      expect(JSON.parse(init.body)).not.toHaveProperty("reasoning");
    }
  });

  it("does not forward credentials to redirects and returns only a redacted failure", async () => {
    let destinationRequests = 0;
    const destination = await listen(
      createServer((_incoming, outgoing) => {
        destinationRequests++;
        outgoing.end("secret-in-error-body");
      }),
    );
    const source = await listen(
      createServer((_incoming, outgoing) => {
        outgoing.writeHead(307, { location: `${destination}/stolen` });
        outgoing.end();
      }),
    );
    const adapter = createOpenAiGuard({
      apiKey: "private-test-key",
      pinnedModel: guard.pinnedModel,
      baseUrl: source,
      fetch,
    });
    await expect(adapter.classify(request)).resolves.toEqual({
      decision: "deny",
      category: "guard_failure",
      reason: "Guard unavailable or invalid.",
      model: guard.pinnedModel,
      policyVersion: "v1",
    });
    expect(destinationRequests).toBe(0);
  });

  it("retains review decisions, exact model binding, and error redaction", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(response(guard.pinnedModel, "review")))
      .mockResolvedValueOnce(Response.json(response("gpt-5.6-luna")))
      .mockRejectedValueOnce(new Error("private-test-key"))
      .mockResolvedValueOnce(new Response("private-test-key", { status: 401 }));
    const adapter = createOpenAiGuard({
      apiKey: "private-test-key",
      pinnedModel: guard.pinnedModel,
      fetch: fetcher,
    });
    await expect(adapter.classify(request)).resolves.toMatchObject({ decision: "review" });
    for (let index = 0; index < 3; index++) {
      const result = await adapter.classify(request);
      expect(result).toMatchObject({ decision: "deny", category: "guard_failure" });
      expect(JSON.stringify(result)).not.toContain("private-test-key");
    }
  });

  it("fails closed on an unresolved configured ref without env fallback", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-key");
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createConfiguredGuard(
        ReefChannelConfigSchema.parse({
          guard: { ...guard, apiKey: { source: "file", provider: "missing", id: "value" } },
        }),
        fetcher,
      ),
    ).rejects.toThrow("Reef guard credential is unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("guard endpoint and configuration validation", () => {
  it.each([
    "https://api.example/v1",
    "http://127.0.0.1:8790/v1",
    "http://127.2.3.4/v1",
    "http://[::1]:8790/v1",
  ])("accepts %s", (url) => {
    expect(parseGuardBaseUrl(url)).toBe(url);
    expect(
      ReefChannelConfigSchema.safeParse({ guard: { ...guard, apiKey: "marker", baseUrl: url } })
        .success,
    ).toBe(true);
  });
  it.each([
    "http://localhost/v1",
    "http://example.com/v1",
    "http://127.1/v1",
    "http://2130706433/v1",
    "http://0x7f000001/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/v1#fragment",
    "https://example.com/\\evil",
    " https://example.com/v1",
    "file:///tmp/key",
  ])("rejects %s", (url) => {
    expect(() => parseGuardBaseUrl(url)).toThrow("Invalid Reef guard base URL");
    expect(
      ReefChannelConfigSchema.safeParse({ guard: { ...guard, apiKey: "marker", baseUrl: url } })
        .success,
    ).toBe(false);
  });
  it("rejects missing or ambiguous credentials and Anthropic reasoning", () => {
    for (const options of [
      {},
      { apiKey: "marker", apiKeyEnv: "REEF_KEY" },
      { provider: "anthropic", apiKey: "marker", reasoningEffort: "medium" },
    ]) {
      expect(ReefChannelConfigSchema.safeParse({ guard: { ...guard, ...options } }).success).toBe(
        false,
      );
    }
    expect(() =>
      createAnthropicGuard({
        apiKey: "marker",
        pinnedModel: "claude-haiku-4-5-20251001",
        reasoningEffort: "medium",
        fetch,
      }),
    ).toThrow("OpenAI guard");
  });
});
