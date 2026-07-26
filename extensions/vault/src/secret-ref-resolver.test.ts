import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const resolverPath = fileURLToPath(new URL("../vault-secret-ref-resolver.js", import.meta.url));
const secretIdHelperPath = fileURLToPath(new URL("../vault-secret-id.js", import.meta.url));
const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

function runResolver(params: {
  request: unknown;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VAULT_ADDR: "",
        VAULT_TOKEN: "",
        VAULT_TOKEN_FILE: "",
        VAULT_NAMESPACE: "",
        OPENCLAW_VAULT_AUTH_METHOD: "",
        OPENCLAW_VAULT_AUTH_MOUNT: "",
        OPENCLAW_VAULT_AUTH_ROLE: "",
        OPENCLAW_VAULT_JWT_FILE: "",
        OPENCLAW_VAULT_KV_MOUNT: "",
        OPENCLAW_VAULT_KV_VERSION: "",
        ...params.env,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout =
      params.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, params.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(`${JSON.stringify(params.request)}\n`);
  });
}

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function writeTempFile(name: string, value: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-vault-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, value, "utf8");
  return filePath;
}

async function startVaultFixture() {
  const requests: Array<{ url?: string; token?: string; namespace?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      token: request.headers["x-vault-token"]?.toString(),
      namespace: request.headers["x-vault-namespace"]?.toString(),
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: {
          data: {
            apiKey: "not-a-real-vault-value",
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    requests,
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

async function startVaultErrorFixture(
  statusCode = 403,
  errors = ["token not-a-real-sensitive-value denied"],
  lookupSucceeds = true,
  lookupErrors = errors,
  lookupStatusCode = statusCode,
) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/v1/auth/token/lookup-self" && lookupSucceeds) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { id: "redacted-fixture-token" } }));
      return;
    }
    response.statusCode =
      request.url === "/v1/auth/token/lookup-self" ? lookupStatusCode : statusCode;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        errors: request.url === "/v1/auth/token/lookup-self" ? lookupErrors : errors,
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    requests,
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

async function startVaultMixedErrorFixture() {
  const server = createServer((request, response) => {
    response.statusCode = request.url?.includes("/providers/openai") ? 403 : 503;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ errors: ["not-a-real-sensitive-value"] }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

async function startVaultStalledBodyFixture() {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.write('{"data":{"data":{"value":"partial');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

async function startVaultOversizedErrorBodyFixture() {
  const server = createServer((request, response) => {
    if (request.url === "/v1/auth/token/lookup-self") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { id: "redacted-fixture-token" } }));
      return;
    }
    response.statusCode = 403;
    response.setHeader("content-type", "application/json");
    response.setHeader("content-length", String(64 * 1024 + 1));
    response.write('{"errors":["partial');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("error", reject);
    request.on("end", () => resolve(body));
  });
}

async function startVaultJwtFixture() {
  const requests: Array<{
    url?: string;
    method?: string;
    token?: string;
    namespace?: string;
    body?: unknown;
  }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requests.push({
        url: request.url,
        method: request.method,
        token: request.headers["x-vault-token"]?.toString(),
        namespace: request.headers["x-vault-namespace"]?.toString(),
        body: body ? JSON.parse(body) : undefined,
      });
      response.setHeader("content-type", "application/json");
      if (
        request.url === "/v1/auth/keycloak/login" ||
        request.url === "/v1/auth/kubernetes/login"
      ) {
        response.end(
          JSON.stringify({
            auth: {
              client_token: "not-a-real-vault-client-token",
            },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            data: {
              apiKey: "not-a-real-vault-value",
            },
          },
        }),
      );
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    requests,
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

async function startVaultJwtErrorFixture() {
  const server = createServer((request, response) => {
    void readRequestBody(request)
      .then(() => {
        response.statusCode = 403;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ errors: ["jwt not-a-real-sensitive-jwt denied"] }));
      })
      .catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

describe("plugin manifest", () => {
  it("declares the Vault resolver as a managed Node SecretRef preset", () => {
    const resolverSource = readFileSync(resolverPath, "utf8");
    const childTimeoutMatch = /const VAULT_FETCH_TIMEOUT_MS = (\d+);/u.exec(resolverSource);
    const childTimeoutMs = Number(childTimeoutMatch?.[1]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      secretProviderIntegrations?: Record<string, Record<string, unknown>>;
    };
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      openclaw?: {
        build?: {
          staticAssets?: Array<{ source?: string; output?: string }>;
        };
      };
    };

    expect(manifest.secretProviderIntegrations?.vault).toMatchObject({
      providerAlias: "vault",
      source: "exec",
      command: "${node}",
      args: ["./vault-secret-ref-resolver.js"],
      passEnv: expect.arrayContaining([
        "VAULT_ADDR",
        "VAULT_TOKEN",
        "VAULT_TOKEN_FILE",
        "OPENCLAW_VAULT_AUTH_METHOD",
        "OPENCLAW_VAULT_AUTH_MOUNT",
        "OPENCLAW_VAULT_AUTH_ROLE",
        "OPENCLAW_VAULT_JWT_FILE",
        "NODE_EXTRA_CA_CERTS",
        "NODE_USE_SYSTEM_CA",
      ]),
    });
    expect(childTimeoutMs).toBeGreaterThan(0);
    expect(manifest.secretProviderIntegrations?.vault?.timeoutMs).toBeGreaterThan(
      childTimeoutMs * 2,
    );
    expect(manifest.secretProviderIntegrations?.vault?.noOutputTimeoutMs).toBeGreaterThan(
      childTimeoutMs * 2,
    );
    expect(manifest.secretProviderIntegrations?.vault?.passEnv).not.toContain(
      "OPENCLAW_VAULT_VALUES_JSON",
    );
    expect(manifest.secretProviderIntegrations?.vault?.allowInsecurePath).toBeUndefined();
    expect(resolverSource).toContain("#!/usr/bin/env node");
    const pluginSdkRootImport = ["openclaw", "plugin-sdk"].join("/");
    expect(resolverSource).not.toContain(pluginSdkRootImport);
    expect(resolverSource).toContain("@openclaw/fs-safe/secret");
    expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
      source: "./vault-secret-ref-resolver.js",
      output: "vault-secret-ref-resolver.js",
    });
    expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
      source: "./vault-secret-id.js",
      output: "vault-secret-id.js",
    });
    expect(readFileSync(secretIdHelperPath, "utf8")).toContain("parseVaultSecretId");
  });
});

describe("vault SecretRef resolver", () => {
  it("requires Vault auth instead of accepting plaintext inline values", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: "https://vault.example.test",
        OPENCLAW_VAULT_VALUES_JSON: JSON.stringify({
          "providers/openai/apiKey": "not-a-real-value",
        }),
      },
    });

    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: "VAULT_TOKEN is required.",
        },
      },
    });
  });

  it("reads KV v2 secrets from Vault using path and field ids", async () => {
    const fixture = await startVaultFixture();
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "test-token",
        VAULT_NAMESPACE: "team-a",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {
        "providers/openai/apiKey": "not-a-real-vault-value",
      },
      errors: {},
    });
    expect(fixture.requests).toEqual([
      {
        url: "/v1/secret/data/providers/openai",
        token: "test-token",
        namespace: "team-a",
      },
    ]);
  });

  it("rejects dot segments before building Vault request URLs", async () => {
    const fixture = await startVaultFixture();
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/../../../sys/mounts/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/../../../sys/mounts/apiKey": {
          message:
            'Vault SecretRef id "providers/../../../sys/mounts/apiKey" must not contain dot path segments.',
        },
      },
    });
    expect(fixture.requests).toEqual([]);
  });

  it.each(["/providers/openai/apiKey", "providers/openai/apiKey/", "providers//openai/apiKey"])(
    "rejects empty path segments in Vault id %s",
    async (id) => {
      const fixture = await startVaultFixture();
      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "vault",
          ids: [id],
        },
        env: {
          VAULT_ADDR: fixture.vaultAddr,
          VAULT_TOKEN: "not-a-real-auth-header",
        },
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: 1,
        values: {},
        errors: {
          [id]: {
            message: `Vault SecretRef id "${id}" must not contain empty path segments.`,
          },
        },
      });
      expect(fixture.requests).toEqual([]);
    },
  );

  it("reads the Vault client token from a token file", async () => {
    const fixture = await startVaultFixture();
    const tokenFile = await writeTempFile("vault-token", "not-a-real-file-token\n");
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN_FILE: tokenFile,
        OPENCLAW_VAULT_AUTH_METHOD: "token_file",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {
        "providers/openai/apiKey": "not-a-real-vault-value",
      },
      errors: {},
    });
    expect(fixture.requests).toEqual([
      {
        url: "/v1/secret/data/providers/openai",
        token: "not-a-real-file-token",
        namespace: undefined,
      },
    ]);
  });

  it("rejects oversized Vault token files before sending a request", async () => {
    const fixture = await startVaultFixture();
    const tokenFile = await writeTempFile("vault-token", "x".repeat(16 * 1024 + 1));
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN_FILE: tokenFile,
        OPENCLAW_VAULT_AUTH_METHOD: "token_file",
      },
    });

    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: expect.stringContaining("exceeds 16384 bytes"),
        },
      },
    });
    expect(fixture.requests).toEqual([]);
  });

  it("exchanges a workload JWT for a Vault token before reading KV secrets", async () => {
    const fixture = await startVaultJwtFixture();
    const jwtFile = await writeTempFile("vault-jwt", "not-a-real-workload-jwt\n");
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_NAMESPACE: "team-a",
        OPENCLAW_VAULT_AUTH_METHOD: "jwt",
        OPENCLAW_VAULT_AUTH_MOUNT: "keycloak",
        OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
        OPENCLAW_VAULT_JWT_FILE: jwtFile,
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {
        "providers/openai/apiKey": "not-a-real-vault-value",
      },
      errors: {},
    });
    expect(fixture.requests).toEqual([
      {
        url: "/v1/auth/keycloak/login",
        method: "POST",
        token: undefined,
        namespace: "team-a",
        body: {
          role: "openclaw",
          jwt: "not-a-real-workload-jwt",
        },
      },
      {
        url: "/v1/secret/data/providers/openai",
        method: "GET",
        token: "not-a-real-vault-client-token",
        namespace: "team-a",
        body: undefined,
      },
    ]);
  });

  it.each(["jwt", "kubernetes"])(
    "rejects oversized Vault JWT files before %s login",
    async (authMethod) => {
      const fixture = await startVaultJwtFixture();
      const jwtFile = await writeTempFile("vault-jwt", "x".repeat(16 * 1024 + 1));
      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "vault",
          ids: ["providers/openai/apiKey"],
        },
        env: {
          VAULT_ADDR: fixture.vaultAddr,
          OPENCLAW_VAULT_AUTH_METHOD: authMethod,
          OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
          OPENCLAW_VAULT_JWT_FILE: jwtFile,
        },
      });

      expect(result).toMatchObject({ code: 1, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: 1,
        values: {},
        errors: {
          request: {
            message: expect.stringContaining("exceeds 16384 bytes"),
          },
        },
      });
      expect(fixture.requests).toEqual([]);
    },
  );

  it("uses Vault kubernetes auth defaults with a service account JWT file", async () => {
    const fixture = await startVaultJwtFixture();
    const jwtFile = await writeTempFile("kubernetes-service-account-token", "not-a-real-k8s-jwt\n");
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        OPENCLAW_VAULT_AUTH_METHOD: "kubernetes",
        OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
        OPENCLAW_VAULT_JWT_FILE: jwtFile,
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {
        "providers/openai/apiKey": "not-a-real-vault-value",
      },
      errors: {},
    });
    expect(fixture.requests).toEqual([
      {
        url: "/v1/auth/kubernetes/login",
        method: "POST",
        token: undefined,
        namespace: undefined,
        body: {
          role: "openclaw",
          jwt: "not-a-real-k8s-jwt",
        },
      },
      {
        url: "/v1/secret/data/providers/openai",
        method: "GET",
        token: "not-a-real-vault-client-token",
        namespace: undefined,
        body: undefined,
      },
    ]);
  });

  it("reports one provider failure when Vault auth is unavailable for multiple ids", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/anthropic/apiKey", "tts/elevenlabs/apiKey"],
      },
      env: {
        VAULT_ADDR: "https://vault.example.test",
      },
    });

    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: "VAULT_TOKEN is required.",
        },
      },
    });
  });

  it("keeps Vault secret read failures scoped per id without echoing response bodies", async () => {
    const fixture = await startVaultErrorFixture();
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/openai/apiKey": {
          message: 'Vault read failed for "providers/openai/apiKey" (403).',
        },
        "tts/elevenlabs/apiKey": {
          message: 'Vault read failed for "tts/elevenlabs/apiKey" (403).',
        },
      },
    });
    expect(result.stdout).not.toContain("not-a-real-sensitive-value");
    expect(fixture.requests.filter((url) => url === "/v1/auth/token/lookup-self")).toHaveLength(1);
  });

  it("reports one provider failure when Vault rejects an invalid token", async () => {
    const fixture = await startVaultErrorFixture(403, ["permission denied", "invalid token"]);
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: "Vault read failed (403).",
        },
      },
    });
    expect(result.stdout).not.toContain("permission denied");
    expect(result.stdout).not.toContain("invalid token");
  });

  it("keeps ambiguous token self-lookup 403 responses scoped per id", async () => {
    const fixture = await startVaultErrorFixture(403, ["permission denied"], false);
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/openai/apiKey": {
          message: 'Vault read failed for "providers/openai/apiKey" (403).',
        },
        "tts/elevenlabs/apiKey": {
          message: 'Vault read failed for "tts/elevenlabs/apiKey" (403).',
        },
      },
    });
    expect(fixture.requests.filter((url) => url === "/v1/auth/token/lookup-self")).toHaveLength(1);
  });

  it("keeps ACL failures scoped when token introspection is unavailable", async () => {
    const fixture = await startVaultErrorFixture(
      403,
      ["permission denied"],
      false,
      ["temporarily unavailable"],
      503,
    );
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/openai/apiKey": {
          message: 'Vault read failed for "providers/openai/apiKey" (403).',
        },
        "tts/elevenlabs/apiKey": {
          message: 'Vault read failed for "tts/elevenlabs/apiKey" (403).',
        },
      },
    });
    expect(fixture.requests.filter((url) => url === "/v1/auth/token/lookup-self")).toHaveLength(1);
  });

  it("promotes an explicit invalid-token self-lookup response to one provider failure", async () => {
    const fixture = await startVaultErrorFixture(403, ["permission denied"], false, [
      "invalid token",
      "permission denied",
    ]);
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: "Vault token is invalid.",
        },
      },
    });
    expect(fixture.requests.filter((url) => url === "/v1/auth/token/lookup-self")).toHaveLength(1);
  });

  it.each([412, 472, 473, 503])(
    "reports one provider failure for Vault availability status %s",
    async (statusCode) => {
      const fixture = await startVaultErrorFixture(statusCode);
      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "vault",
          ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
        },
        env: {
          VAULT_ADDR: fixture.vaultAddr,
          VAULT_TOKEN: "not-a-real-auth-header",
        },
      });

      expect(result).toMatchObject({ code: 1, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: 1,
        values: {},
        errors: {
          request: {
            message: `Vault read failed (${statusCode}).`,
          },
        },
      });
      expect(result.stdout).not.toContain("not-a-real-sensitive-value");
    },
  );

  it("preserves per-id failures when a sibling Vault read has a provider outage", async () => {
    const fixture = await startVaultMixedErrorFixture();
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/openai/apiKey": {
          message: 'Vault read failed for "providers/openai/apiKey" (403).',
        },
        "tts/elevenlabs/apiKey": {
          message: "Vault read failed (503).",
        },
      },
    });
    expect(result.stdout).not.toContain("not-a-real-sensitive-value");
  });

  it("does not echo Vault jwt login response bodies in resolver errors", async () => {
    const fixture = await startVaultJwtErrorFixture();
    const jwtFile = await writeTempFile("vault-jwt", "not-a-real-sensitive-jwt\n");
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        OPENCLAW_VAULT_AUTH_METHOD: "jwt",
        OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
        OPENCLAW_VAULT_JWT_FILE: jwtFile,
      },
    });

    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: "Vault jwt login failed (403).",
        },
      },
    });
    expect(result.stdout).not.toContain("not-a-real-sensitive-jwt");
  });

  it("times out while reading a stalled Vault JSON response body", async () => {
    const fixture = await startVaultStalledBodyFixture();
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
      timeoutMs: 6_500,
    });

    expect(result).toMatchObject({ code: 1, stderr: "", timedOut: false });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: "Vault request failed.",
        },
      },
    });
  });

  it("cancels oversized Vault error bodies before clearing the fetch timeout", async () => {
    const fixture = await startVaultOversizedErrorBodyFixture();
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
      timeoutMs: 6_500,
    });

    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/openai/apiKey": {
          message: 'Vault read failed for "providers/openai/apiKey" (403).',
        },
      },
    });
  });
});
