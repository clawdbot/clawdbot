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
  reconcileManagedLlamaServer,
} from "./managed-server.js";

const servers: http.Server[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const TEST_GGUF_SHA256 = "b83633aa785344791618f2fddf131b010ea04912a60430760b070bad293f65bd";

async function withHuggingFaceMetadataFixture(
  endpoint: "manifest" | "file" | "tree",
  run: (params: {
    cacheDir: string;
    setMetadataAvailable: (available: boolean) => void;
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
  let metadataAvailable = true;
  const pathInfoBodies: unknown[] = [];
  const requestedUrls: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    requestedUrls.push(req.url ?? "");
    if (!metadataAvailable) {
      res.statusCode = 503;
      res.end("{}");
      return;
    }
    if (req.url?.startsWith("/v2/owner/repo/manifests/latest")) {
      res.end(
        JSON.stringify({
          ggufFile: { rfilename: "model.gguf", size: 4 },
          ...(endpoint === "manifest" ? { padding } : {}),
        }),
      );
      return;
    }
    if (req.url?.startsWith("/api/models/owner/repo/paths-info/")) {
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
    if (req.url?.startsWith("/api/models/owner/repo/tree/")) {
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
      setMetadataAvailable: (available) => {
        metadataAvailable = available;
      },
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

async function listen(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  return address.port;
}

async function createPresetFixture(label: string) {
  const tempRoot = tempDirs.make(`llama-server-${label}-`);
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
  return { tempRoot, presetPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
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
      "llama-b10809-bin-macos-arm64.tar.gz",
      "7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2",
    ],
    [
      "darwin",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10809-bin-macos-x64.tar.gz",
      "13b34aa8a5d87341a21065a83f54a8167e1aaa6fe0d66065de01632a1ed64be6",
    ],
    [
      "linux",
      "arm64",
      "cpu",
      "tar.gz",
      "llama-b10809-bin-ubuntu-arm64.tar.gz",
      "f2b7333971e1b7b42e9268bfdbfa30f5f56e2897156084d2251385df94aec358",
    ],
    [
      "linux",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10809-bin-ubuntu-x64.tar.gz",
      "5e34434ddc6d03cd1584f403201aff0d4bd1a5793a72ff7e286532dfd1e4b941",
    ],
    [
      "win32",
      "arm64",
      "cpu",
      "zip",
      "llama-b10809-bin-win-cpu-arm64.zip",
      "c1058fe5764a687275c8d20d6bbc1454e787cdbb8ebb8c37a2f959f2b144dc77",
    ],
    [
      "win32",
      "x64",
      "cpu",
      "zip",
      "llama-b10809-bin-win-cpu-x64.zip",
      "9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5",
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

  it("prepares an isolated candidate without changing the active restart preset", async () => {
    const root = tempDirs.make("llama-server-candidate-");
    const presetPath = path.join(root, "models.ini");
    const active = "version = 1\n\n[active-chat]\nmodel = /models/active.gguf\n";
    await fs.writeFile(presetPath, active);
    const asset = selectLlamaServerAsset("darwin", "arm64");
    const command = path.join(root, "llama-server");
    installMocks.ensureLlamaServerInstalled.mockResolvedValue({ command, asset });
    installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
      installDir: root,
      command,
      presetPath,
    });

    const candidate = await prepareManagedLlamaServer({
      chatModel: {
        mode: "configure",
        id: "candidate-chat",
        path: "/models/candidate.gguf",
        contextSize: 16_384,
      },
      embeddingModelPath: "/models/embedding.gguf",
      asset,
      isolated: true,
      port: 19_435,
    });
    const candidatePreset = candidate.args[candidate.args.indexOf("--models-preset") + 1]!;
    expect(candidatePreset).not.toBe(presetPath);
    expect(await fs.readFile(presetPath, "utf8")).toBe(active);
    const contents = await fs.readFile(candidatePreset, "utf8");
    expect(contents).toContain(
      "[candidate-chat]\nmodel = /models/candidate.gguf\nctx-size = 16384",
    );
    expect(contents).toContain("[embeddinggemma-300m-qat-q8_0]\nmodel = /models/embedding.gguf");
    expect(contents).not.toContain("active-chat");
  });

  it.each(["environment preset", "direct model"])(
    "preserves a configured %s service",
    async (mode) => {
      const root = tempDirs.make("llama-server-configured-");
      const presetPath = path.join(root, "custom.ini");
      const localService = {
        command: path.join(root, "custom-server"),
        cwd: root,
        args: mode === "direct model" ? ["--model", "/models/chat.gguf", "--alias", "chat"] : [],
        ...(mode === "environment preset"
          ? { env: { LLAMA_ARG_MODELS_PRESET: "custom.ini" } }
          : {}),
      };
      const runtime = await prepareManagedLlamaServer({
        localService,
        port: 19436,
        chatModel: { mode: "configure", id: "chat", path: "/models/chat.gguf" },
        embeddingModelPath: "/models/embedding.gguf",
      });
      expect(runtime.command).toBe(localService.command);
      expect(runtime.args).toEqual(localService.args);
      if (mode === "environment preset") {
        expect(await fs.readFile(presetPath, "utf8")).toContain(
          "[chat]\nmodel = /models/chat.gguf",
        );
      } else {
        expect(await fs.readdir(root)).toEqual([]);
      }
    },
  );

  it("does not reconcile a configured direct-model service without a router preset", async () => {
    const root = tempDirs.make("llama-server-direct-model-");
    let reloads = 0;
    const server = http.createServer((req, res) => {
      reloads += Number(req.url === "/models?reload=1");
      res.end("{}");
    });
    servers.push(server);
    const port = await listen(server);

    await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--model", "/models/chat.gguf", "--alias", "chat"],
      },
      port,
      chatModel: { mode: "configure", id: "chat", path: "/models/chat.gguf" },
      embeddingModelPath: "/models/embedding.gguf",
    });
    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });

    expect(reloads).toBe(0);
  });

  it.each([
    { route: "args", mode: "preserve", newline: "\n" },
    { route: "env", mode: "preserve", newline: "\r\n" },
    { route: "args", mode: "configure", newline: "\r\n" },
    { route: "env", mode: "configure", newline: "\n" },
  ] as const)(
    "preserves configured preset settings for $route/$mode",
    async ({ route, mode, newline }) => {
      const root = tempDirs.make("llama-server-owned-settings-");
      const presetPath = path.join(root, "custom.ini");
      const global = `version = 1${newline}; operator defaults${newline}[*]${newline}ctx-size = 16384${newline}${newline}`;
      const sibling = `[sibling] ; another model${newline}model = /models/sibling.gguf${newline}n-gpu-layers = 7${newline}${newline}`;
      const chat = `[chat]${newline}model = /models/chat.gguf${newline}c = 4096 ; selected context${newline}n-gpu-layers = 12${newline}${newline}`;
      await fs.writeFile(
        presetPath,
        global +
          "[stale\nmultiline]\nmodel = /models/stale.gguf\n\n".replaceAll("\n", newline) +
          sibling +
          chat +
          `[embeddinggemma-300m-qat-q8_0]${newline}; keep\u2028model = /models/comment.gguf${newline}model = /models/old.gguf ; embedding path${newline}pooling = mean${newline}ubatch-size = 256${newline}`,
      );

      await prepareManagedLlamaServer({
        localService: {
          command: path.join(root, "custom-server"),
          cwd: root,
          ...(route === "args"
            ? { args: ["--models-preset", "custom.ini"] }
            : { env: { LLAMA_ARG_MODELS_PRESET: "custom.ini" } }),
        },
        port: 19436,
        configuredChatModelIds: ["chat", "sibling"],
        chatModel:
          mode === "preserve"
            ? { mode }
            : { mode, id: "chat", path: "/models/chat.gguf", contextSize: 8192 },
        embeddingModelPath: "/models/new.gguf",
      });

      const updated = await fs.readFile(presetPath, "utf8");
      expect(updated.startsWith(global)).toBe(true);
      expect(updated).toContain(sibling.trimEnd());
      expect(updated).not.toContain("[stale");
      expect(updated.indexOf("[chat]")).toBeLessThan(updated.indexOf("[sibling]"));
      expect(updated).toContain(`n-gpu-layers = 12${newline}`);
      expect(updated).toContain(`model = /models/new.gguf ; embedding path${newline}`);
      expect(updated).toContain(`pooling = mean${newline}`);
      expect(updated).toContain(`; keep\u2028model = /models/comment.gguf${newline}`);
      expect(updated).toContain(`ubatch-size = 256${newline}`);
      if (mode === "preserve") {
        expect(updated).toContain(chat);
      } else {
        expect(updated).toContain(`ctx-size = 8192 ; selected context${newline}`);
        expect(updated).not.toContain("c = 4096");
      }
      expect(installMocks.ensureLlamaServerInstalled).not.toHaveBeenCalled();
    },
  );

  it.each(["q4_k_m", "release-Q4_K_M"])(
    "updates the native model's effective %s preset alias",
    async (tag) => {
      const root = tempDirs.make("llama-server-preset-alias-");
      const presetPath = path.join(root, "custom.ini");
      const active = `[chat:${tag}]\nmodel = /models/chat.gguf\nc = 4096\nn-gpu-layers = 12\n`;
      const inactive = "[chat:Q4_K_M]\nmodel = /models/inactive.gguf\n";
      await fs.writeFile(presetPath, `version = 1\n${active}${inactive}`);
      await prepareManagedLlamaServer({
        localService: {
          command: path.join(root, "custom-server"),
          args: ["--models-preset", presetPath],
        },
        port: 19436,
        configuredChatModelIds: ["chat:Q4_K_M"],
        chatModel: {
          mode: "configure",
          id: "chat:Q4_K_M",
          path: "/models/chat.gguf",
          contextSize: 8192,
        },
        embeddingModelPath: "/models/embedding.gguf",
      });
      const updated = await fs.readFile(presetPath, "utf8");
      expect(updated).toContain(active.replace("c = 4096", "ctx-size = 8192"));
      expect(updated).toContain(inactive);
    },
  );

  it("writes a 2048-token physical batch in the combined preset", async () => {
    const { presetPath } = await createPresetFixture("combined-preset");
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
        "version = 1\n\n[*]\ncache-type-k = q8_0\n\n[stale-chat]\nmodel = /models/stale-chat.gguf\n\n" +
          "[embeddinggemma-300m-qat-q8_0]\nmodel = /models/old-embedding.gguf\nembedding = true\n",
      );
      await prepareManagedLlamaServer({
        chatModel: { mode: "remove" },
        embeddingModelPath: "/models/custom-embedding.gguf",
        port: 19_432,
      });
      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toBe(
        "version = 1\n\n[*]\ncache-type-k = q8_0\n\n[embeddinggemma-300m-qat-q8_0]\nmodel = /models/custom-embedding.gguf\nembedding = true\n",
      );
      expect(preset).not.toContain("jinja");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves both model stanzas and the configured CUDA runtime during concurrent preparation", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-chat-preset-"));
    const presetPath = path.join(tempRoot, "models.ini");
    const chatModelPath = path.join(tempRoot, "chat.gguf");
    const embeddingModelPath = path.join(tempRoot, "custom-embedding.gguf");
    const localService = {
      command: path.join(tempRoot, "win32-x64-cuda-12.4", "llama-server.exe"),
      args: ["--models-preset", presetPath],
    };

    try {
      await Promise.all([
        fs.writeFile(chatModelPath, "GGUF"),
        fs.writeFile(embeddingModelPath, "GGUF"),
      ]);
      const [embeddingRuntime] = await Promise.all([
        prepareManagedLlamaServer({
          chatModel: { mode: "preserve" },
          embeddingModelPath,
          port: 19_434,
          localService,
        }),
        ensureManagedLlamaServerForChat({
          provider: {
            baseUrl: "http://127.0.0.1:19434/v1",
            localService,
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

      expect(embeddingRuntime.command).toBe(localService.command);
      expect(embeddingRuntime.args).toContain(presetPath);
      expect(installMocks.ensureLlamaServerInstalled).not.toHaveBeenCalled();
      expect(installMocks.resolveManagedLlamaServerPaths).not.toHaveBeenCalled();
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

  it("retains the chat inventory across A to B to A and reapplies changed limits", async () => {
    const { tempRoot, presetPath } = await createPresetFixture("chat-transitions");
    const firstPath = path.join(tempRoot, "first.gguf");
    const secondPath = path.join(tempRoot, "second.gguf");
    const first = {
      id: "first",
      name: "First",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      params: { modelPath: firstPath, contextSize: 16_384 },
      maxTokens: 1024,
    };
    const second = {
      id: "second",
      name: "Second",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      params: { modelPath: secondPath, contextSize: 32_768 },
      maxTokens: 2048,
    };
    const provider = {
      baseUrl: "http://127.0.0.1:29432/v1",
      localService: {
        command: path.join(tempRoot, "llama-server"),
        args: ["--models-preset", presetPath],
      },
      models: [first, second],
      params: { modelCacheDir: tempRoot },
    };
    await Promise.all([fs.writeFile(firstPath, "GGUF"), fs.writeFile(secondPath, "GGUF")]);
    for (const model of [
      first,
      second,
      { ...first, params: { ...first.params, contextSize: 32_768 }, maxTokens: 4096 },
    ]) {
      await ensureManagedLlamaServerForChat({ provider, model });
    }
    const preset = await fs.readFile(presetPath, "utf8");
    expect(preset).toContain(
      `[first]\nmodel = ${firstPath}\nctx-size = 32768\nn-predict = 4096\njinja = true`,
    );
    expect(preset).toContain(
      `[second]\nmodel = ${secondPath}\nctx-size = 32768\nn-predict = 2048\njinja = true`,
    );
    expect(preset.indexOf("[first]")).toBeLessThan(preset.indexOf("[second]"));
  });

  it("prunes and orders sections without rewriting or reloading unchanged bytes", async () => {
    const { presetPath } = await createPresetFixture("chat-prune");
    let reloads = 0;
    const server = http.createServer((req, res) => {
      reloads += Number(req.url === "/models?reload=1");
      res.end("{}");
    });
    servers.push(server);
    const port = await listen(server);
    const rename = vi.spyOn(fs, "rename");
    const params = {
      chatModel: { mode: "preserve" as const },
      configuredChatModelIds: ["zeta", "alpha"],
      port,
    };
    await fs.writeFile(
      presetPath,
      [
        "; operator header",
        "version = 1",
        "",
        "[*]",
        "n-gpu-layers = 12",
        "",
        "[stale]",
        "model = /models/stale.gguf",
        "",
        "[zeta]",
        "model = /models/zeta.gguf",
        "",
        "[alpha]",
        "model = /models/alpha.gguf",
        "",
        "[embeddinggemma-300m-qat-q8_0]",
        "model = /models/embedding.gguf",
        "embedding = true",
        "",
      ].join("\n"),
    );
    await prepareManagedLlamaServer(params);
    await prepareManagedLlamaServer(params);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    await reconcileManagedLlamaServer({ baseUrl });
    await reconcileManagedLlamaServer({ baseUrl });
    expect(await fs.readFile(presetPath, "utf8")).toBe(
      [
        "; operator header",
        "version = 1",
        "",
        "[*]",
        "n-gpu-layers = 12",
        "",
        "[alpha]",
        "model = /models/alpha.gguf",
        "",
        "[zeta]",
        "model = /models/zeta.gguf",
        "",
        "[embeddinggemma-300m-qat-q8_0]",
        "model = /models/embedding.gguf",
        "embedding = true",
        "",
      ].join("\n"),
    );
    expect(rename).toHaveBeenCalledTimes(1);
    expect(reloads).toBe(1);
  });

  it("tracks applied preset revisions independently by managed origin", async () => {
    await createPresetFixture("origin-transition");
    const reloads = [0, 0];
    const createReloadServer = (index: number) =>
      http.createServer((req, res) => {
        reloads[index]! += Number(req.url === "/models?reload=1");
        res.end("{}");
      });
    const firstServer = createReloadServer(0);
    const secondServer = createReloadServer(1);
    servers.push(firstServer, secondServer);
    const firstPort = await listen(firstServer);
    const secondPort = await listen(secondServer);
    await prepareManagedLlamaServer({
      chatModel: { mode: "remove" },
      configuredChatModelIds: [],
      embeddingModelPath: "/models/embedding.gguf",
      port: firstPort,
    });
    await prepareManagedLlamaServer({
      chatModel: { mode: "remove" },
      configuredChatModelIds: [],
      embeddingModelPath: "/models/embedding.gguf",
      port: secondPort,
    });
    const firstBaseUrl = `http://127.0.0.1:${firstPort}/v1`;
    const secondBaseUrl = `http://127.0.0.1:${secondPort}/v1`;

    await reconcileManagedLlamaServer({ baseUrl: firstBaseUrl });
    await reconcileManagedLlamaServer({ baseUrl: secondBaseUrl });
    await reconcileManagedLlamaServer({ baseUrl: firstBaseUrl });

    expect(reloads).toEqual([1, 1]);
  });

  it("reconciles using the configured managed-service origin", async () => {
    await createPresetFixture("configured-origin");
    let reloads = 0;
    const server = http.createServer((req, res) => {
      reloads += Number(req.url === "/models?reload=1");
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test server address");
    }
    const baseUrl = `http://localhost:${address.port}/v1`;
    await prepareManagedLlamaServer({
      chatModel: { mode: "remove" },
      configuredChatModelIds: [],
      embeddingModelPath: "/models/embedding.gguf",
      port: address.port,
      reconcileBaseUrl: baseUrl,
    });

    await reconcileManagedLlamaServer({ baseUrl });

    expect(reloads).toBe(1);
  });

  it("retains a failed reload revision for the next reconciliation", async () => {
    await createPresetFixture("reload-failure");
    let status = 500;
    let reloads = 0;
    const server = http.createServer((_req, res) => {
      reloads += 1;
      res.statusCode = status;
      res.end("{}");
    });
    servers.push(server);
    const port = await listen(server);
    await prepareManagedLlamaServer({
      chatModel: { mode: "remove" },
      configuredChatModelIds: [],
      embeddingModelPath: "/models/embedding.gguf",
      port,
    });
    await expect(
      reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` }),
    ).rejects.toThrow("llama.cpp preset reload failed: HTTP 500");
    const controller = new AbortController();
    controller.abort(new Error("reload aborted"));
    await expect(
      reconcileManagedLlamaServer({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        signal: controller.signal,
      }),
    ).rejects.toBe(controller.signal.reason);
    status = 200;
    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });
    expect(reloads).toBe(2);
  });

  it("allows reloads to use llama.cpp's pinned model shutdown window", async () => {
    await createPresetFixture("reload-shutdown-window");
    let reloads = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/models?reload=1") {
        reloads += 1;
        setTimeout(() => res.end("{}"), 2_600);
        return;
      }
      res.end("{}");
    });
    servers.push(server);
    const port = await listen(server);
    await prepareManagedLlamaServer({
      chatModel: { mode: "remove" },
      configuredChatModelIds: [],
      embeddingModelPath: "/models/embedding.gguf",
      port,
    });

    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });

    expect(reloads).toBe(1);
  });

  it("reconciles a mutation after the child reads the preset but before it listens", async () => {
    const { presetPath } = await createPresetFixture("startup-race");
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
    const prepare = async (contextSize: number) =>
      await prepareManagedLlamaServer({
        chatModel: {
          mode: "configure",
          id: "chat",
          path: "/models/chat.gguf",
          contextSize,
          maxTokens: 2048,
        },
        configuredChatModelIds: ["chat"],
        defaultEmbeddingModelPath: "/models/embedding.gguf",
        port,
      });
    await prepare(8192);
    let loadedPreset = await fs.readFile(presetPath, "utf8");
    await prepare(16_384);

    let reloads = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/models?reload=1") {
        reloads += 1;
        void fs.readFile(presetPath, "utf8").then((contents) => {
          loadedPreset = contents;
          res.end("{}");
        });
        return;
      }
      res.end("{}");
    });
    servers.push(server);
    await listen(server, port);
    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });
    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });

    expect(reloads).toBe(1);
    expect(loadedPreset).toContain("ctx-size = 16384");
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
            source: `hf:owner/repo#oversized-${endpoint}`,
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

  it("keeps a verified custom Hugging Face artifact available while refreshing its preset", async () => {
    await withHuggingFaceMetadataFixture(
      "file",
      async ({ cacheDir, setMetadataAvailable, source }) => {
        const presetPath = path.join(cacheDir, "models.ini");
        const localService = {
          command: path.join(cacheDir, "llama-server"),
          args: ["--models-preset", presetPath],
        };
        const model = {
          id: "custom-chat",
          name: "Custom Chat",
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          params: { modelPath: source, contextSize: 8192 },
          maxTokens: 1024,
        };
        const provider = {
          baseUrl: "http://127.0.0.1:19432/v1",
          localService,
          models: [model],
          params: { modelCacheDir: cacheDir },
        };

        await ensureManagedLlamaServerForChat({ provider, model });
        setMetadataAvailable(false);
        model.maxTokens = 2048;
        await ensureManagedLlamaServerForChat({ provider, model });

        expect(await fs.readFile(presetPath, "utf8")).toContain("n-predict = 2048");
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
