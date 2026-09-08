import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
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
let server: Server | undefined;
const requests: Array<{ headers: IncomingHttpHeaders }> = [];
const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-repro-134700-"));

try {
  server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      requests.push({ headers: request.headers });
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

  const createOptions = (apiKey?: string) => ({
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
            ...(apiKey === undefined ? {} : { apiKey }),
            models: [],
          },
        },
      },
    },
    agentDir,
    provider: "tenant-embeddings",
    model: "tenant-embeddings/fixture-model",
  });

  const omittedKey = await openAICompatibleEmbeddingProviderAdapter.create(createOptions());
  await omittedKey.provider.embed("hello");

  const explicitProfile = await openAICompatibleEmbeddingProviderAdapter.create(
    createOptions(profileId),
  );
  await explicitProfile.provider.embed("hello");

  const omittedAuthorization = requests[0]?.headers.authorization;
  const explicitAuthorization = requests[1]?.headers.authorization;
  console.log(`omitted-apiKey authorization=${omittedAuthorization ? "present" : "missing"}`);
  console.log(
    `explicit-profile-reference authorization=${
      explicitAuthorization === `Bearer ${profileKey}` ? "profile" : "other"
    }`,
  );
  if (omittedAuthorization !== undefined) {
    throw new Error("omitted apiKey unexpectedly sent Authorization");
  }
  if (explicitAuthorization !== `Bearer ${profileKey}`) {
    throw new Error("explicit profile reference did not send its stored credential");
  }
} finally {
  closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
  closeOpenClawAgentDatabases(agentDir);
  await rm(agentDir, { force: true, recursive: true });
  server?.closeAllConnections();
  const runningServer = server;
  if (runningServer) {
    await new Promise<void>((resolve, reject) => {
      runningServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
