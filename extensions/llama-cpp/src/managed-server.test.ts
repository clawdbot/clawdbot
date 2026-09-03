import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const installMocks = vi.hoisted(() => ({
  ensureLlamaServerInstalled: vi.fn(),
  resolveManagedLlamaServerPaths: vi.fn(),
}));

vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: installMocks.ensureLlamaServerInstalled,
  resolveManagedLlamaServerPaths: installMocks.resolveManagedLlamaServerPaths,
}));

import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { selectLlamaServerAsset } from "./llama-server-install.js";
import {
  ensureLlamaCppModel,
  ensureManagedLlamaServerForChat,
  inspectLlamaServerRuntime,
  prepareManagedLlamaServer,
} from "./managed-server.js";

const servers: http.Server[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const TEST_GGUF_SHA256 = "b83633aa785344791618f2fddf131b010ea04912a60430760b070bad293f65bd";

async function withHuggingFaceMetadataFixture(
  endpoint: "manifest" | "file" | "tree",
  run: (params: {
    cacheDir: string;
    setPadding: (target: "manifest" | "file" | "tree", padding: string) => void;
    pathInfoBodies: unknown[];
    requestedUrls: string[];
    source: string;
  }) => Promise<void>,
  source = "hf:owner/repo",
): Promise<void> {
  const cacheDir = tempDirs.make(`llama-cpp-hf-${endpoint}-`);
  await fs.writeFile(path.join(cacheDir, "hf_owner_repo_model.gguf"), "GGUF");
  let padding = "x".repeat(1024 * 1024);
  const pathInfoBodies: unknown[] = [];
  const requestedUrls: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    requestedUrls.push(req.url ?? "");
    if (req.url?.startsWith("/v2/owner/repo/manifests/latest")) {
      res.end(
        JSON.stringify({
          ggufFile: { rfilename: "model.gguf", size: 4 },
          ...(endpoint === "manifest" ? { padding } : {}),
        }),
      );
      return;
    }
    if (req.url?.startsWith("/api/models/owner/repo/paths-info/main")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        pathInfoBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end(
          JSON.stringify([
            { path: "model.gguf", size: 4, lfs: { oid: TEST_GGUF_SHA256 } },
            ...(endpoint === "file" ? [padding] : []),
          ]),
        );
      });
      return;
    }
    if (req.url?.startsWith("/api/models/owner/repo/tree/main")) {
      res.end(
        JSON.stringify([
          { path: "model.gguf", size: 4, lfs: { oid: TEST_GGUF_SHA256 } },
          ...(endpoint === "tree" ? [padding] : []),
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  const realFetch = globalThis.fetch;
  const localFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const upstream = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return await realFetch(`http://127.0.0.1:${address.port}${upstream.pathname}`, init);
  });
  vi.stubGlobal("fetch", localFetch);
  try {
    await run({
      cacheDir,
      setPadding: (target, next) => {
        if (target === endpoint) {
          padding = next;
        }
      },
      pathInfoBodies,
      requestedUrls,
      source,
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("managed llama-server", () => {
  it.each([
    [
      "darwin",
      "arm64",
      "metal",
      "tar.gz",
      "llama-b10534-bin-macos-arm64.tar.gz",
      "51f193eef26b053554e288fb924b24d41d3d7b2bafa338c19e2817fa793d5e86",
    ],
    [
      "darwin",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10534-bin-macos-x64.tar.gz",
      "69b13035f4301354922a8cfacd1bcf2bb2de4ff0c2e19fedb44963378ff53dc5",
    ],
    [
      "linux",
      "arm64",
      "cpu",
      "tar.gz",
      "llama-b10534-bin-ubuntu-arm64.tar.gz",
      "66535de5cb9293c075a1951c51a3b2ae6f1899623e21177845f6d2a73b78c94e",
    ],
    [
      "linux",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10534-bin-ubuntu-x64.tar.gz",
      "cc6a12b026edcf1b211be2bb7366c5dadcad778fd8f13019d0694038053d5e4a",
    ],
    [
      "win32",
      "arm64",
      "cpu",
      "zip",
      "llama-b10534-bin-win-cpu-arm64.zip",
      "d33618b10fda35d34d85da60926c6c470f98f3f66ce6b52c3c1f583461416012",
    ],
    [
      "win32",
      "x64",
      "cpu",
      "zip",
      "llama-b10534-bin-win-cpu-x64.zip",
      "295ae03ad58d9276afa36f5f8d111d67fc1491c7aff3a3e6d13051a772f93c21",
    ],
  ] as const)(
    "selects the pinned %s/%s asset",
    (platform, arch, backend, archive, name, sha256) => {
      expect(selectLlamaServerAsset(platform, arch)).toMatchObject({
        platform,
        arch,
        backend,
        archive,
        name,
        sha256,
      });
    },
  );

  it("fails unsupported platforms with an actionable manual path", () => {
    expect(() => selectLlamaServerAsset("freebsd", "x64")).toThrow(
      "Install a compatible llama-server manually",
    );
  });

  it("writes a 2048-token physical batch in the combined preset", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-preset-"));
    const presetPath = path.join(tempRoot, "models.ini");
    const asset = selectLlamaServerAsset("darwin", "arm64");
    installMocks.ensureLlamaServerInstalled.mockResolvedValue({
      command: path.join(tempRoot, "llama-server"),
      asset,
    });
    installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
      installDir: tempRoot,
      command: path.join(tempRoot, "llama-server"),
      presetPath,
    });

    try {
      await prepareManagedLlamaServer({
        chatModel: {
          mode: "configure",
          id: "chat-model",
          path: "/models/chat.gguf",
          contextSize: 8192,
          maxTokens: 2048,
        },
        embeddingModelIsDefault: true,
        embeddingModelPath: "/models/embedding.gguf",
        port: 19_432,
      });
      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toContain("[chat-model]\nmodel = /models/chat.gguf\nctx-size = 8192");
      expect(preset).toContain(
        "[embeddinggemma-300m-qat-q8_0]\nmodel = /models/embedding.gguf\nubatch-size = 2048\nembedding = true",
      );
      expect(preset).not.toMatch(/mmproj|draft/iu);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the llama.cpp physical batch default for a custom embedding model", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-embedding-only-"));
    const presetPath = path.join(tempRoot, "models.ini");
    const asset = selectLlamaServerAsset("darwin", "arm64");
    installMocks.ensureLlamaServerInstalled.mockResolvedValue({
      command: path.join(tempRoot, "llama-server"),
      asset,
    });
    installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
      installDir: tempRoot,
      command: path.join(tempRoot, "llama-server"),
      presetPath,
    });

    try {
      await fs.writeFile(
        presetPath,
        "version = 1\n\n[stale-chat]\nmodel = /models/stale-chat.gguf\n\n" +
          "[embeddinggemma-300m-qat-q8_0]\nmodel = /models/old-embedding.gguf\nembedding = true\n",
      );
      await prepareManagedLlamaServer({
        chatModel: { mode: "remove" },
        embeddingModelPath: "/models/custom-embedding.gguf",
        port: 19_432,
      });
      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toBe(
        "version = 1\n\n[embeddinggemma-300m-qat-q8_0]\nmodel = /models/custom-embedding.gguf\nembedding = true\n",
      );
      expect(preset).not.toContain("jinja");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves a custom embedding model when chat prepares the shared restart preset", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-chat-preset-"));
    const presetPath = path.join(tempRoot, "models.ini");
    const chatModelPath = path.join(tempRoot, "chat.gguf");
    const embeddingModelPath = path.join(tempRoot, "custom-embedding.gguf");
    const asset = selectLlamaServerAsset("darwin", "arm64");
    installMocks.ensureLlamaServerInstalled.mockResolvedValue({
      command: path.join(tempRoot, "llama-server"),
      asset,
    });
    installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
      installDir: tempRoot,
      command: path.join(tempRoot, "llama-server"),
      presetPath,
    });

    try {
      await Promise.all([
        fs.writeFile(chatModelPath, "GGUF"),
        fs.writeFile(embeddingModelPath, "GGUF"),
      ]);
      await Promise.all([
        prepareManagedLlamaServer({
          chatModel: { mode: "preserve" },
          embeddingModelPath,
          port: 19_434,
        }),
        ensureManagedLlamaServerForChat({
          provider: {
            baseUrl: "http://127.0.0.1:19434/v1",
            localService: { command: path.join(tempRoot, "llama-server"), args: [] },
            models: [],
            params: { modelCacheDir: tempRoot },
          },
          model: {
            id: "chat-model",
            params: { modelPath: chatModelPath, contextSize: 8192 },
            maxTokens: 2048,
          },
        }),
      ]);

      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toContain(`[chat-model]\nmodel = ${chatModelPath}\nctx-size = 8192`);
      expect(preset).toContain(
        `[embeddinggemma-300m-qat-q8_0]\nmodel = ${embeddingModelPath}\nembedding = true`,
      );
      expect(preset).not.toContain("ubatch-size");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports a missing local GGUF with the setup repair path", async () => {
    await expect(
      ensureLlamaCppModel({
        source: path.join(os.tmpdir(), "missing-openclaw-model.gguf"),
        cacheDir: os.tmpdir(),
        download: false,
      }),
    ).rejects.toThrow("Run interactive llama.cpp setup or correct params.modelPath");
  });

  it.each(["manifest", "file"] as const)(
    "bounds Hugging Face %s metadata while preserving a legitimate response",
    async (endpoint) => {
      await withHuggingFaceMetadataFixture(endpoint, async ({ cacheDir, setPadding }) => {
        await expect(
          ensureLlamaCppModel({
            source: "hf:owner/repo",
            cacheDir,
            download: false,
          }),
        ).resolves.toBe(path.join(cacheDir, "hf_owner_repo_model.gguf"));

        setPadding(endpoint, "x".repeat(16 * 1024 * 1024 + 1));
        await expect(
          ensureLlamaCppModel({
            source: "hf:owner/repo",
            cacheDir,
            download: false,
          }),
        ).rejects.toThrow(
          `llama.cpp Hugging Face ${endpoint === "manifest" ? "manifest" : "file metadata"}: JSON response exceeds 16777216 bytes`,
        );
      });
    },
  );

  it("resolves a cached GGUF when unrelated repository tree metadata is oversized", async () => {
    await withHuggingFaceMetadataFixture(
      "tree",
      async ({ cacheDir, setPadding, pathInfoBodies, requestedUrls, source }) => {
        setPadding("tree", "x".repeat(16 * 1024 * 1024 + 1));
        await expect(
          ensureLlamaCppModel({
            source,
            cacheDir,
            download: false,
          }),
        ).resolves.toBe(path.join(cacheDir, "hf_owner_repo_model.gguf"));
        expect(pathInfoBodies).toEqual([{ paths: ["model.gguf"], expand: false }]);
        expect(requestedUrls.some((url) => url.includes("/tree/"))).toBe(false);
      },
    );
  });

  it("resolves an explicit Hugging Face GGUF file without a manifest request", async () => {
    await withHuggingFaceMetadataFixture(
      "file",
      async ({ cacheDir, pathInfoBodies, requestedUrls, source }) => {
        await expect(ensureLlamaCppModel({ source, cacheDir, download: false })).resolves.toBe(
          path.join(cacheDir, "hf_owner_repo_model.gguf"),
        );
        expect(pathInfoBodies).toEqual([{ paths: ["model.gguf"], expand: false }]);
        expect(requestedUrls).not.toContain("/v2/owner/repo/manifests/latest");
      },
      "hf:owner/repo/model.gguf",
    );
  });

  it("reports only facts observed from health, models, props, and metrics", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url === "/models") {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "embedding-model",
                path: "/models/from-models.gguf",
                status: { value: "loaded" },
              },
            ],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/props?")) {
        res.end(
          JSON.stringify({
            build_info: "b10357 (689e227db)",
            model_path: "/models/from-props.gguf",
            modalities: { vision: false },
          }),
        );
        return;
      }
      if (req.url?.startsWith("/metrics?")) {
        res.setHeader("content-type", "text/plain");
        res.end("llamacpp:prompt_tokens_total 1\n");
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test server address");
    }

    await expect(
      inspectLlamaServerRuntime({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: "embedding-model",
        backend: "metal",
      }),
    ).resolves.toEqual({
      engine: "llama.cpp",
      state: "ready",
      backend: "metal",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embedding-model", path: "/models/from-props.gguf" },
      capabilities: { vision: false, draft: false },
      endpoints: {
        health: "ready",
        models: "ready",
        props: "ready",
        metrics: "ready",
      },
    });
  });

  it.each(["metrics", "props"] as const)(
    "bounds %s inspection responses while accepting a legitimate large body",
    async (endpoint) => {
      let padding = "x".repeat(1024 * 1024);
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith(`/${endpoint}?`)) {
          res.setHeader("content-type", endpoint === "metrics" ? "text/plain" : "application/json");
          res.end(endpoint === "metrics" ? padding : JSON.stringify({ padding }));
          return;
        }
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") {
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (req.url === "/models") {
          res.end(JSON.stringify({ data: [{ id: "embedding-model" }] }));
          return;
        }
        if (req.url?.startsWith("/props?")) {
          res.end(JSON.stringify({ modalities: { vision: false } }));
          return;
        }
        if (req.url?.startsWith("/metrics?")) {
          res.setHeader("content-type", "text/plain");
          res.end("llamacpp:requests_total 1\n");
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      servers.push(server);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing test server address");
      }
      const inspect = () =>
        inspectLlamaServerRuntime({
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: "embedding-model",
        });

      await expect(inspect()).resolves.toMatchObject({
        state: "ready",
        endpoints: { health: "ready", models: "ready", props: "ready", metrics: "ready" },
      });

      padding = "x".repeat(32 * 1024 * 1024);
      await expect(inspect()).resolves.toMatchObject({
        state: "failed",
        endpoints: {
          health: "ready",
          models: "ready",
          props: endpoint === "props" ? "unavailable" : "ready",
          metrics: endpoint === "metrics" ? "unavailable" : "ready",
        },
      });
    },
  );
});
