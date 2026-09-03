import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import type { NodeWorkerBundleTransferHttpCallback } from "./worker-environments/node-worker-bundle-transfer-http.js";
import type { NodeWorkspaceTransferHttpCallback } from "./worker-environments/node-workspace-transfer-http.js";
import type { WorkerBootstrapArtifactTransferHttpCallback } from "./worker-environments/worker-bootstrap-artifact-transfer-http.js";

const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
const activeLimiters: AuthRateLimiter[] = [];

afterEach(() => {
  for (const limiter of activeLimiters.splice(0)) {
    limiter.dispose();
  }
});

async function withTransferServer<T>(params: {
  bundleCallback?: NodeWorkerBundleTransferHttpCallback;
  bootstrapCallback?: WorkerBootstrapArtifactTransferHttpCallback;
  callback?: NodeWorkspaceTransferHttpCallback;
  limiter?: AuthRateLimiter;
  hooks?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  run(origin: string): Promise<T>;
}): Promise<T> {
  const server = createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: true,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: params.hooks ?? (async () => false),
    resolvedAuth,
    joinRateLimiter: params.limiter,
    handleNodeWorkerBundleTransferRequest: params.bundleCallback,
    handleWorkerBootstrapArtifactTransferRequest: params.bootstrapCallback,
    handleNodeWorkspaceTransferRequest: params.callback,
    getRuntimeConfig: () => ({}),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await params.run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

describe("node worker bundle transfer HTTP routing", () => {
  it("reserves the exact bundle namespace and collapses rejected auth", async () => {
    const hooks = vi.fn(async () => false);
    const callback = vi.fn<NodeWorkerBundleTransferHttpCallback>(async () => ({
      kind: "unauthorized",
    }));
    await withTransferServer({
      bundleCallback: callback,
      hooks,
      run: async (origin) => {
        const url = `${origin}/__openclaw__/worker-bundle/v1/bundles/${"a".repeat(64)}`;
        const missing = await fetch(url);
        const rejected = await fetch(url, {
          headers: { authorization: "Bearer rejected-transfer-token" },
        });
        const queried = await fetch(`${url}?alias=true`, {
          headers: { authorization: "Bearer rejected-transfer-token" },
        });

        expect(missing.status).toBe(404);
        expect(rejected.status).toBe(404);
        expect(queried.status).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("no-store");
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
      },
    });
  });

  it("lets an authenticated exact bundle route own its response", async () => {
    const callback: NodeWorkerBundleTransferHttpCallback = async ({ bearer, bundleHash, res }) => {
      if (bearer !== "valid-bundle-token") {
        return { kind: "unauthorized" };
      }
      return {
        kind: "authorized",
        handle: () => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(bundleHash);
        },
      };
    };
    await withTransferServer({
      bundleCallback: callback,
      run: async (origin) => {
        const bundleHash = "b".repeat(64);
        const response = await fetch(
          `${origin}/__openclaw__/worker-bundle/v1/bundles/${bundleHash}`,
          { headers: { authorization: "Bearer valid-bundle-token" } },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.text()).resolves.toBe(bundleHash);
      },
    });
  });
});

describe("cloud bootstrap artifact HTTP routing", () => {
  it("serves only an authorized exact artifact before node enrollment and reserves malformed paths", async () => {
    const hooks = vi.fn(async () => false);
    const callback = vi.fn<WorkerBootstrapArtifactTransferHttpCallback>(
      async ({ bearer, artifactSha256, res }) =>
        bearer === "bootstrap-capability"
          ? {
              kind: "authorized",
              handle: () => {
                res.end(artifactSha256);
              },
            }
          : { kind: "unauthorized" },
    );
    await withTransferServer({
      bootstrapCallback: callback,
      hooks,
      run: async (origin) => {
        const digest = "c".repeat(64);
        const url = `${origin}/__openclaw__/worker-bootstrap/artifacts/${digest}`;
        for (const target of [
          url,
          `${url}?token=bootstrap-capability`,
          `${origin}/__openclaw__/worker-bootstrap/invalid`,
        ]) {
          const response = await fetch(target);
          expect(response.status).toBe(404);
          expect(response.headers.get("cache-control")).toBe("no-store");
        }
        const response = await fetch(url, {
          headers: { authorization: "Bearer bootstrap-capability" },
        });
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe(digest);
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
      },
    });
  });
});

describe("node workspace transfer HTTP routing", () => {
  it("reserves the namespace before hooks and collapses missing or rejected auth", async () => {
    const hooks = vi.fn(async () => false);
    const callback = vi.fn<NodeWorkspaceTransferHttpCallback>(async () => ({
      kind: "unauthorized",
    }));
    await withTransferServer({
      callback,
      hooks,
      run: async (origin) => {
        const path = `/__openclaw__/worker-transfer/v1/environments/worker%3Afixture/snapshots/${"a".repeat(64)}/pack`;
        const missing = await fetch(`${origin}${path}`);
        const rejected = await fetch(`${origin}${path}`, {
          headers: { authorization: "Bearer rejected-transfer-token" },
        });

        expect(missing.status).toBe(404);
        expect(rejected.status).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("no-store");
        expect(rejected.headers.get("cache-control")).toBe("no-store");
        await expect(missing.json()).resolves.toEqual({ error: "not_found" });
        await expect(rejected.json()).resolves.toEqual({ error: "not_found" });
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
      },
    });
  });

  it("parses the closed route family and lets authenticated work own its response", async () => {
    const routes: Array<{ kind: string; environmentId: string }> = [];
    const callback: NodeWorkspaceTransferHttpCallback = async ({ bearer, res, route }) => {
      if (bearer !== "valid-transfer-token") {
        return { kind: "unauthorized" };
      }
      routes.push(route);
      return {
        kind: "authorized",
        handle: () => {
          if (route.kind === "reconcile") {
            writeJson(res, 413, { error: "workspace_transfer_limit" });
            return;
          }
          writeJson(res, 200, { kind: route.kind });
        },
      };
    };
    await withTransferServer({
      callback,
      run: async (origin) => {
        const base = `${origin}/__openclaw__/worker-transfer/v1/environments/worker%3Afixture`;
        const authorization = { authorization: "Bearer valid-transfer-token" };
        const manifest = await fetch(`${base}/snapshots/${"a".repeat(64)}/manifest`, {
          headers: authorization,
        });
        const pack = await fetch(`${base}/snapshots/${"a".repeat(64)}/pack`, {
          headers: authorization,
        });
        const blob = await fetch(`${base}/blobs/${"b".repeat(64)}`, {
          headers: authorization,
        });
        const reconcile = await fetch(`${base}/reconciliations/${"a".repeat(64)}`, {
          method: "POST",
          headers: authorization,
        });

        expect(manifest.status).toBe(200);
        expect(pack.status).toBe(200);
        expect(blob.status).toBe(200);
        expect(reconcile.status).toBe(413);
        expect(pack.headers.get("cache-control")).toBe("no-store");
        expect(reconcile.headers.get("cache-control")).toBe("no-store");
        await expect(reconcile.json()).resolves.toEqual({ error: "workspace_transfer_limit" });
        expect(routes).toEqual([
          {
            kind: "manifest",
            direction: "download",
            environmentId: "worker:fixture",
            manifestRef: `sha256:${"a".repeat(64)}`,
          },
          {
            kind: "pack",
            direction: "download",
            environmentId: "worker:fixture",
            manifestRef: `sha256:${"a".repeat(64)}`,
          },
          {
            kind: "blob",
            direction: "download",
            environmentId: "worker:fixture",
            sha256: "b".repeat(64),
          },
          {
            kind: "reconcile",
            direction: "upload",
            environmentId: "worker:fixture",
            baseManifestRef: `sha256:${"a".repeat(64)}`,
          },
        ]);
      },
    });
  });

  it("rate-limits invalid transfer auth before invoking the callback again", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
    });
    activeLimiters.push(limiter);
    const callback = vi.fn<NodeWorkspaceTransferHttpCallback>(async () => ({
      kind: "unauthorized",
    }));
    await withTransferServer({
      callback,
      limiter,
      run: async (origin) => {
        const transferRoot = `${origin}/__openclaw__/worker-transfer/v1/environments/worker%3Afixture`;
        const url = `${transferRoot}/snapshots/${"a".repeat(64)}/pack`;
        const rejected = await fetch(url, {
          headers: { authorization: "Bearer rejected-transfer-token" },
        });
        const limited = await fetch(url, {
          headers: { authorization: "Bearer another-transfer-token" },
        });

        expect(rejected.status).toBe(404);
        expect(limited.status).toBe(429);
        expect(limited.headers.get("cache-control")).toBe("no-store");
        expect(limited.headers.get("retry-after")).toBe("60");
        await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
        expect(callback).toHaveBeenCalledOnce();
      },
    });
  });
});
