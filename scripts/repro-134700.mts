import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.env.OPENCLAW_PROOF_REPO?.trim() || path.resolve(import.meta.dirname, "..");
const { openAICompatibleEmbeddingProviderAdapter } = await import(
  pathToFileURL(path.join(repoRoot, "src/plugins/openai-compatible-embedding-provider.ts")).href
);
const { closeAuthProfileReadPool, writePersistedAuthProfileStoreRaw } = await import(
  pathToFileURL(path.join(repoRoot, "src/agents/auth-profiles/sqlite.ts")).href
);
const { closeOpenClawAgentDatabases } = await import(
  pathToFileURL(path.join(repoRoot, "src/state/openclaw-agent-db.ts")).href
);

const profileId = "tenant-embeddings:profile-only";
const profileKey = "synthetic-profile-only-key";
const negativeControl = process.env.OPENCLAW_PROOF_MODE === "explicit-empty";
const expectedAuthorization = process.env.OPENCLAW_PROOF_EXPECTED?.trim() || "profile";
let server: Server | undefined;
let receivedHeaders: IncomingHttpHeaders | undefined;
const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-repro-134700-"));

try {
  server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      receivedHeaders = request.headers;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.25, 0.5, 0.75] }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("repro fixture did not expose a TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  writePersistedAuthProfileStoreRaw(
    {
      version: 1,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider: "tenant-embeddings",
          key: profileKey,
        },
      },
    },
    agentDir,
  );

  const result = await openAICompatibleEmbeddingProviderAdapter.create({
    config: {
      auth: {
        profiles: { [profileId]: { provider: "tenant-embeddings", mode: "api_key" } },
        order: { "tenant-embeddings": [profileId] },
      },
      models: {
        providers: {
          "tenant-embeddings": {
            api: "openai-completions",
            baseUrl,
            ...(negativeControl ? { apiKey: "" } : {}),
            models: [],
          },
        },
      },
    },
    agentDir,
    provider: "tenant-embeddings",
    model: "tenant-embeddings/fixture-model",
  });
  const embedding = await result.provider?.embed("hello");
  const authorization = receivedHeaders?.authorization;
  const authorizationClass =
    authorization === `Bearer ${profileKey}` ? "profile" : authorization ? "other" : "missing";
  const observation = `mode=${negativeControl ? "explicit-empty" : "profile-only"} authorization=${authorizationClass} embedding=${embedding?.length ?? 0}`;
  console.log(observation);
  if (authorizationClass !== expectedAuthorization) {
    console.error(`${observation} expected=${expectedAuthorization}`);
    process.exitCode = 1;
  }
} finally {
  closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
  closeOpenClawAgentDatabases(agentDir);
  await rm(agentDir, { force: true, recursive: true });
  server?.closeAllConnections();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
