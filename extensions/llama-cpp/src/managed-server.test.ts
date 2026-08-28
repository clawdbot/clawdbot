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

import { selectLlamaServerAsset } from "./llama-server-install.js";
import {
  ensureLlamaCppModel,
  ensureManagedLlamaServerForChat,
  inspectLlamaServerRuntime,
  prepareManagedLlamaServer,
} from "./managed-server.js";

const servers: http.Server[] = [];

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
      "llama-b10488-bin-macos-arm64.tar.gz",
      "ada90bbc4787caac49fbb95ed2487a03fb4bbb456057a31e316878e1a895827a",
    ],
    [
      "darwin",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10488-bin-macos-x64.tar.gz",
      "80567f47511d5e11872835614b99cd678fa276b05553563e8aab3f2cb6b90abd",
    ],
    [
      "linux",
      "arm64",
      "cpu",
      "tar.gz",
      "llama-b10488-bin-ubuntu-arm64.tar.gz",
      "e977e13e9d72b8ee0068336bb9196f4f8158e8b53b8d502dc8bdb55eaea1222f",
    ],
    [
      "linux",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10488-bin-ubuntu-x64.tar.gz",
      "5a7073371d5a9b8e39978b35f49b2ff244f7a064edb92f0326d94e12b52261dd",
    ],
    [
      "win32",
      "arm64",
      "cpu",
      "zip",
      "llama-b10488-bin-win-cpu-arm64.zip",
      "97a883831728862568a0e7e38380e7a179b6bcb292167f648a5598586dd65635",
    ],
    [
      "win32",
      "x64",
      "cpu",
      "zip",
      "llama-b10488-bin-win-cpu-x64.zip",
      "6c938f6d79aac96cb90fda673aade20cff9b1b6c1e97de04f4d5d60bca107082",
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
});
