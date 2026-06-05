// Memory Host SDK tests cover embeddings behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_EMBEDDING_WORKER_ERROR_CODES } from "./embedding-worker-errors.js";
import { createLocalEmbeddingWorkerProvider } from "./embeddings-worker.js";
import { createLocalEmbeddingProviderInProcess, DEFAULT_LOCAL_MODEL } from "./embeddings.js";

const nodeLlamaMock = vi.hoisted(() => ({
  importNodeLlamaCpp: vi.fn(),
}));

vi.mock("./node-llama.js", () => ({
  importNodeLlamaCpp: nodeLlamaMock.importNodeLlamaCpp,
}));

beforeEach(() => {
  nodeLlamaMock.importNodeLlamaCpp.mockReset();
});

afterEach(() => {
  vi.resetAllMocks();
});

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

function mockLocalEmbeddingRuntime(vector = new Float32Array([2.35, 3.45, 0.63, 4.3])) {
  const disposeContext = vi.fn();
  const disposeModel = vi.fn();
  const disposeLlama = vi.fn();
  const getEmbeddingFor = vi.fn().mockResolvedValue({ vector });
  const createEmbeddingContext = vi
    .fn()
    .mockResolvedValue({ getEmbeddingFor, dispose: disposeContext });
  const loadModel = vi.fn().mockResolvedValue({ createEmbeddingContext, dispose: disposeModel });
  const getLlama = vi.fn(async () => ({ loadModel, dispose: disposeLlama }));
  const resolveModelFile = vi.fn(async (modelPath: string) => `/resolved/${modelPath}`);

  nodeLlamaMock.importNodeLlamaCpp.mockResolvedValue({
    getLlama,
    resolveModelFile,
    LlamaLogLevel: { error: 0 },
  } as never);

  return {
    createEmbeddingContext,
    disposeContext,
    disposeLlama,
    disposeModel,
    getLlama,
    getEmbeddingFor,
    loadModel,
    resolveModelFile,
  };
}

describe("local embedding provider", () => {
  it("normalizes local embeddings and resolves the default local model", async () => {
    const runtime = mockLocalEmbeddingRuntime();

    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    const embedding = await provider.embedQuery("test query");
    const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));

    expect(DEFAULT_LOCAL_MODEL).toBe(
      "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
    );
    expect(magnitude).toBeCloseTo(1, 5);
    expect(runtime.resolveModelFile).toHaveBeenCalledWith(
      DEFAULT_LOCAL_MODEL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runtime.loadModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: `/resolved/${DEFAULT_LOCAL_MODEL}`,
        loadSignal: expect.any(AbortSignal),
      }),
    );
    expect(runtime.getEmbeddingFor).toHaveBeenCalledWith("test query");
  });

  it("passes default contextSize (4096) to createEmbeddingContext when not configured", async () => {
    const runtime = mockLocalEmbeddingRuntime();

    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("context size default test");

    expect(runtime.createEmbeddingContext).toHaveBeenCalledWith(
      expect.objectContaining({ contextSize: 4096, createSignal: expect.any(AbortSignal) }),
    );
  });

  it("passes configured contextSize to createEmbeddingContext", async () => {
    const runtime = mockLocalEmbeddingRuntime();

    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
      local: { contextSize: 2048 },
    });

    await provider.embedQuery("context size custom test");

    expect(runtime.createEmbeddingContext).toHaveBeenCalledWith(
      expect.objectContaining({ contextSize: 2048, createSignal: expect.any(AbortSignal) }),
    );
  });

  it('passes "auto" contextSize to createEmbeddingContext when explicitly set', async () => {
    const runtime = mockLocalEmbeddingRuntime();

    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
      local: { contextSize: "auto" },
    });

    await provider.embedQuery("context size auto test");

    expect(runtime.createEmbeddingContext).toHaveBeenCalledWith(
      expect.objectContaining({ contextSize: "auto", createSignal: expect.any(AbortSignal) }),
    );
  });

  it("runs local batch embeddings sequentially", async () => {
    const calls: string[] = [];
    const firstGate = createDeferred<{ vector: Float32Array }>();
    const secondGate = createDeferred<{ vector: Float32Array }>();
    const getEmbeddingFor = vi.fn((text: string) => {
      calls.push(text);
      return text === "first" ? firstGate.promise : secondGate.promise;
    });
    nodeLlamaMock.importNodeLlamaCpp.mockResolvedValue({
      getLlama: vi.fn(async () => ({
        loadModel: vi.fn(async () => ({
          createEmbeddingContext: vi.fn(async () => ({ getEmbeddingFor })),
        })),
      })),
      resolveModelFile: vi.fn(async () => "/resolved/model.gguf"),
      LlamaLogLevel: { error: 0 },
    } as never);
    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    const batchPromise = provider.embedBatch(["first", "second"]);
    await expect.poll(() => calls.join(",")).toBe("first");
    firstGate.resolve({ vector: new Float32Array([1, 0]) });
    await expect.poll(() => calls.join(",")).toBe("first,second");
    secondGate.resolve({ vector: new Float32Array([0, 1]) });

    await expect(batchPromise).resolves.toHaveLength(2);
  });

  it("trims explicit local model paths and cache directories", async () => {
    const runtime = mockLocalEmbeddingRuntime(new Float32Array([1, 0]));

    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
      local: {
        modelPath: "  /models/embed.gguf  ",
        modelCacheDir: "  /cache/models  ",
      },
    });

    await provider.embedBatch(["a", "b"]);

    expect(provider.model).toBe("/models/embed.gguf");
    expect(runtime.resolveModelFile).toHaveBeenCalledWith(
      "/models/embed.gguf",
      expect.objectContaining({
        directory: "/cache/models",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(runtime.getEmbeddingFor).toHaveBeenCalledTimes(2);
  });

  it("disposes cached local llama resources when closed", async () => {
    const runtime = mockLocalEmbeddingRuntime();

    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("load local resources");
    await provider.close?.();
    await provider.close?.();

    expect(runtime.disposeContext).toHaveBeenCalledTimes(1);
    expect(runtime.disposeModel).toHaveBeenCalledTimes(1);
    expect(runtime.disposeLlama).toHaveBeenCalledTimes(1);
    await expect(provider.embedQuery("after close")).rejects.toThrow(
      "Local embedding provider has been closed",
    );
  });

  it("does not wait for pending local llama initialization before close resolves", async () => {
    const disposeLlama = vi.fn();
    const getLlamaGate = createDeferred<unknown>();
    nodeLlamaMock.importNodeLlamaCpp.mockResolvedValue({
      getLlama: async () => (await getLlamaGate.promise) as never,
      resolveModelFile: vi.fn(async (modelPath: string) => `/resolved/${modelPath}`),
      LlamaLogLevel: { error: 0 },
    } as never);
    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    const embedPromise = provider.embedQuery("pending init");
    await expect(provider.close?.()).resolves.toBeUndefined();

    getLlamaGate.resolve({ loadModel: vi.fn(), dispose: disposeLlama });
    await expect(embedPromise).rejects.toThrow("Local embedding provider has been closed");
    expect(disposeLlama).toHaveBeenCalledTimes(1);
  });

  it("aborts pending local llama model loads when closed", async () => {
    const loadModelStarted = createDeferred<void>();
    const loadModelGate = createDeferred<never>();
    const disposeLlama = vi.fn();
    let capturedResolveSignal: AbortSignal | undefined;
    let capturedLoadSignal: AbortSignal | undefined;
    const loadModel = vi.fn(
      (params: { modelPath: string; loadSignal?: AbortSignal }): Promise<never> => {
        capturedLoadSignal = params.loadSignal;
        loadModelStarted.resolve();
        return loadModelGate.promise;
      },
    );
    nodeLlamaMock.importNodeLlamaCpp.mockResolvedValue({
      getLlama: async () => ({ loadModel, dispose: disposeLlama }),
      resolveModelFile: vi.fn(async (_modelPath: string, options?: { signal?: AbortSignal }) => {
        capturedResolveSignal = options?.signal;
        return "/resolved/model.gguf";
      }),
      LlamaLogLevel: { error: 0 },
    } as never);
    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    const embedPromise = provider.embedQuery("pending model load");
    await loadModelStarted.promise;
    await expect(provider.close?.()).resolves.toBeUndefined();

    expect(capturedResolveSignal?.aborted).toBe(true);
    expect(capturedLoadSignal?.aborted).toBe(true);
    expect(disposeLlama).toHaveBeenCalledTimes(1);
    loadModelGate.reject(new Error("load aborted"));
    await expect(embedPromise).rejects.toThrow("load aborted");
  });

  it("aborts pending local llama embedding context creation when closed", async () => {
    const createContextStarted = createDeferred<void>();
    const createContextGate = createDeferred<never>();
    const disposeLlama = vi.fn();
    const disposeModel = vi.fn();
    let capturedCreateSignal: AbortSignal | undefined;
    const createEmbeddingContext = vi.fn(
      (options?: { createSignal?: AbortSignal }): Promise<never> => {
        capturedCreateSignal = options?.createSignal;
        createContextStarted.resolve();
        return createContextGate.promise;
      },
    );
    nodeLlamaMock.importNodeLlamaCpp.mockResolvedValue({
      getLlama: async () => ({
        loadModel: vi.fn(async () => ({ createEmbeddingContext, dispose: disposeModel })),
        dispose: disposeLlama,
      }),
      resolveModelFile: vi.fn(async () => "/resolved/model.gguf"),
      LlamaLogLevel: { error: 0 },
    } as never);
    const provider = await createLocalEmbeddingProviderInProcess({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    const embedPromise = provider.embedQuery("pending context create");
    await createContextStarted.promise;
    await expect(provider.close?.()).resolves.toBeUndefined();

    expect(capturedCreateSignal?.aborted).toBe(true);
    expect(disposeModel).toHaveBeenCalledTimes(1);
    expect(disposeLlama).toHaveBeenCalledTimes(1);
    createContextGate.reject(new Error("context create aborted"));
    await expect(embedPromise).rejects.toThrow("context create aborted");
  });

  it("uses a worker process for the public local provider", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-embedding-worker-"));
    const workerScript = path.join(tempDir, "worker.cjs");
    await fs.writeFile(
      workerScript,
      `
process.on("message", (message) => {
  if (message.type === "initialize") {
    process.send({ id: message.id, ok: true });
    return;
  }
  if (message.type === "embedQuery") {
    process.send({ id: message.id, ok: true, value: [1, 0] });
    return;
  }
  if (message.type === "embedBatch") {
    process.send({ id: message.id, ok: true, value: message.texts.map(() => [0, 1]) });
    return;
  }
  process.send({ id: message.id, ok: true });
});
`,
      "utf8",
    );
    const provider = await createLocalEmbeddingWorkerProvider(
      {
        config: {} as never,
        provider: "local",
        model: "",
        fallback: "none",
      },
      { workerScriptPath: workerScript },
    );

    await expect(provider.embedQuery("hello")).resolves.toEqual([1, 0]);
    await expect(provider.embedBatch(["a", "b"])).resolves.toEqual([
      [0, 1],
      [0, 1],
    ]);
    await expect(provider.close?.()).resolves.toBeUndefined();
  });

  it("terminates the worker when close runs behind a pending request", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-embedding-worker-"));
    const workerScript = path.join(tempDir, "worker.cjs");
    const embedStartedPath = path.join(tempDir, "embed-started");
    await fs.writeFile(
      workerScript,
      `
const fs = require("node:fs");
const embedStartedPath = ${JSON.stringify(embedStartedPath)};
let busy = false;

process.on("message", (message) => {
  if (busy) {
    return;
  }
  if (message.type === "initialize") {
    process.send({ id: message.id, ok: true });
    return;
  }
  if (message.type === "embedQuery") {
    busy = true;
    fs.writeFileSync(embedStartedPath, "1");
  }
});
`,
      "utf8",
    );
    const provider = await createLocalEmbeddingWorkerProvider(
      {
        config: {} as never,
        provider: "local",
        model: "",
        fallback: "none",
      },
      { workerScriptPath: workerScript },
    );

    const embedPromise = provider.embedQuery("stuck");
    const embedError = embedPromise.then(
      () => undefined,
      (err: unknown) => err,
    );
    await expect
      .poll(async () => {
        try {
          await fs.access(embedStartedPath);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);

    const closePromise = provider.close?.() ?? Promise.resolve();
    const closeResult = await Promise.race([
      closePromise.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 1_000);
      }),
    ]);

    expect(closeResult).toBe("closed");
    await expect(embedError).resolves.toMatchObject({
      code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.exited,
    });
  });

  it("does not pass inline-source or inspector exec args to the file-backed worker", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-embedding-worker-"));
    const workerScript = path.join(tempDir, "worker.cjs");
    await fs.writeFile(
      workerScript,
      `
process.on("message", (message) => {
  if (message.type === "initialize" || message.type === "close") {
    process.send({ id: message.id, ok: true });
    return;
  }
  process.send({ id: message.id, ok: true, value: [process.execArgv.length] });
});
`,
      "utf8",
    );
    const originalExecArgv = [...process.execArgv];
    let provider: Awaited<ReturnType<typeof createLocalEmbeddingWorkerProvider>> | undefined;
    try {
      process.execArgv.splice(
        0,
        process.execArgv.length,
        "--eval",
        "setInterval(() => {}, 1000)",
        "--print",
        "1 + 1",
        "--input-type=module",
        "--inspect-brk=127.0.0.1:0",
        "--inspect-port",
        "0",
      );
      provider = await createLocalEmbeddingWorkerProvider(
        {
          config: {} as never,
          provider: "local",
          model: "",
          fallback: "none",
        },
        { workerScriptPath: workerScript },
      );
      await expect(provider.embedQuery("hello")).resolves.toEqual([0]);
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
      await provider?.close?.();
    }
  });

  it("reports worker initialization failures during provider creation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-embedding-worker-"));
    const workerScript = path.join(tempDir, "worker.cjs");
    await fs.writeFile(
      workerScript,
      `
process.on("message", (message) => {
  process.send({
    id: message.id,
    ok: false,
    error: { message: "Cannot find package 'node-llama-cpp'", code: "ERR_MODULE_NOT_FOUND" },
  });
});
`,
      "utf8",
    );

    try {
      await createLocalEmbeddingWorkerProvider(
        {
          config: {} as never,
          provider: "local",
          model: "",
          fallback: "none",
        },
        { workerScriptPath: workerScript },
      );
      throw new Error("expected local embedding provider creation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Cannot find package 'node-llama-cpp'");
      expect((err as Error & { code?: string }).code).toBe("ERR_MODULE_NOT_FOUND");
    }
  });

  it("reports worker exits with structured failure codes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-embedding-worker-"));
    const workerScript = path.join(tempDir, "worker.cjs");
    await fs.writeFile(
      workerScript,
      `
process.on("message", (message) => {
  if (message.type === "initialize") {
    process.send({ id: message.id, ok: true });
    return;
  }
  process.exit(134);
});
`,
      "utf8",
    );
    const provider = await createLocalEmbeddingWorkerProvider(
      {
        config: {} as never,
        provider: "local",
        model: "",
        fallback: "none",
      },
      { workerScriptPath: workerScript },
    );

    await expect(provider.embedQuery("hello")).rejects.toMatchObject({
      code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.exited,
      reason: "exit",
      exitCode: 134,
    });
  });
});
