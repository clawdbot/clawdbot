// QA Lab tests cover lab server plugin behavior.
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUiAssetVersion } from "./lab-server-ui.js";
import { startQaLabServer, type QaLabServerStartParams } from "./lab-server.js";

const qaChannelMock = vi.hoisted(() => ({
  resolveAccount: vi.fn(),
  setRuntime: vi.fn(),
  startAccount: vi.fn(),
}));

const suiteLaunchMock = vi.hoisted(() => ({
  runQaSuite: vi.fn(),
}));
const liveTransportMock = vi.hoisted(() => ({
  adapterFactories: [{ id: "live-test-factory", matches: vi.fn(), create: vi.fn() }],
  listAdapterFactories: vi.fn(),
}));

vi.mock("./suite-launch.runtime.js", () => ({
  runQaSuite: suiteLaunchMock.runQaSuite,
}));

vi.mock("./live-transports/cli.js", () => ({
  listLiveTransportQaAdapterFactories: liveTransportMock.listAdapterFactories,
}));

vi.mock("openclaw/plugin-sdk/qa-channel", () => ({
  qaChannelPlugin: {
    config: {
      resolveAccount: qaChannelMock.resolveAccount,
    },
    gateway: {
      startAccount: qaChannelMock.startAccount,
    },
  },
  setQaChannelRuntime: qaChannelMock.setRuntime,
}));

const captureMock = vi.hoisted(() => {
  const sessions: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  const readMeta = (event: Record<string, unknown>) => {
    try {
      return typeof event.metaJson === "string"
        ? (JSON.parse(event.metaJson) as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const countValues = (values: Array<string | undefined>) =>
    Object.entries(
      values.reduce<Record<string, number>>((acc, value) => {
        if (value) {
          acc[value] = (acc[value] ?? 0) + 1;
        }
        return acc;
      }, {}),
    ).map(([value, count]) => ({ value, count }));
  const countMatching = <T>(values: T[], predicate: (value: T) => boolean) => {
    let count = 0;
    for (const value of values) {
      if (predicate(value)) {
        count += 1;
      }
    }
    return count;
  };

  const store = {
    upsertSession(session: Record<string, unknown>) {
      sessions.push({ ...session });
    },
    recordEvent(event: Record<string, unknown>) {
      events.push({ ...event });
    },
    listSessions(limit: number) {
      return sessions.slice(0, limit).map((session) =>
        Object.assign({}, session, {
          eventCount: countMatching(events, (event) => event.sessionId === session.id),
        }),
      );
    },
    getSessionEvents(sessionId: string, limit: number) {
      return events.filter((event) => event.sessionId === sessionId).slice(0, limit);
    },
    summarizeSessionCoverage(sessionId: string) {
      const selected = events.filter((event) => event.sessionId === sessionId);
      const metas = selected.map(readMeta);
      return {
        sessionId,
        totalEvents: selected.length,
        unlabeledEventCount: countMatching(metas, (meta) => !meta.provider && !meta.model),
        providers: countValues(metas.map((meta) => meta.provider as string | undefined)),
        apis: countValues(metas.map((meta) => meta.api as string | undefined)),
        models: countValues(metas.map((meta) => meta.model as string | undefined)),
        hosts: countValues(selected.map((event) => event.host as string | undefined)),
        localPeers: countValues(
          selected
            .map((event) => event.host as string | undefined)
            .filter((host) => host?.startsWith("127.0.0.1:")),
        ),
      };
    },
    queryPreset(preset: string, sessionId?: string) {
      if (preset !== "double-sends") {
        return [];
      }
      const selected = events.filter((event) => !sessionId || event.sessionId === sessionId);
      const counts = selected.reduce<Record<string, number>>((acc, event) => {
        const host = typeof event.host === "string" ? event.host : "";
        if (host) {
          acc[host] = (acc[host] ?? 0) + 1;
        }
        return acc;
      }, {});
      return Object.entries(counts)
        .filter(([, duplicateCount]) => duplicateCount > 1)
        .map(([host, duplicateCount]) => ({ host, duplicateCount }));
    },
    readBlob() {
      return null;
    },
    close: vi.fn(),
    deleteSessions(sessionIds: string[]) {
      const ids = new Set(sessionIds);
      for (let index = sessions.length - 1; index >= 0; index -= 1) {
        if (ids.has(String(sessions[index]?.id))) {
          sessions.splice(index, 1);
        }
      }
      return { deleted: sessionIds.length };
    },
    purgeAll() {
      sessions.splice(0);
      events.splice(0);
      return { deletedSessions: 0, deletedEvents: 0 };
    },
  };

  return {
    acquire: vi.fn(() => ({
      store,
      release: store.close,
    })),
    store,
    reset() {
      sessions.splice(0);
      events.splice(0);
      captureMock.acquire.mockClear();
      store.close.mockClear();
    },
  };
});

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  acquireDebugProxyCaptureStore: captureMock.acquire,
  getDebugProxyCaptureStore: () => captureMock.store,
  resolveDebugProxySettings: () => ({
    proxyUrl: process.env.OPENCLAW_DEBUG_PROXY_URL ?? "",
    sessionId: "qa-lab-test",
  }),
}));

const cleanups: Array<() => Promise<void>> = [];

async function startQaLabServerForTest(params?: QaLabServerStartParams) {
  return await startQaLabServer({
    embeddedGateway: "disabled",
    ...params,
  });
}

beforeEach(() => {
  suiteLaunchMock.runQaSuite.mockReset();
  liveTransportMock.listAdapterFactories.mockReset();
  liveTransportMock.listAdapterFactories.mockReturnValue(liveTransportMock.adapterFactories);
  liveTransportMock.adapterFactories[0]!.matches.mockReset();
  qaChannelMock.resolveAccount.mockReset();
  qaChannelMock.resolveAccount.mockImplementation((_cfg: unknown, accountId: string) => ({
    accountId,
    configured: true,
    enabled: true,
  }));
  qaChannelMock.setRuntime.mockReset();
  qaChannelMock.startAccount.mockReset();
  qaChannelMock.startAccount.mockImplementation(
    async ({ abortSignal }: { abortSignal?: AbortSignal }) =>
      await new Promise<void>((resolve) => {
        if (!abortSignal) {
          resolve();
          return;
        }
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  captureMock.reset();
});

function isRetryableLocalFetchError(error: unknown) {
  if (!(error instanceof TypeError)) {
    return false;
  }
  const cause = (error as TypeError & { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") {
    return false;
  }
  const code = "code" in cause ? (cause as { code?: unknown }).code : undefined;
  return code === "ECONNRESET" || code === "UND_ERR_SOCKET";
}

async function fetchWithRetry(input: string, init?: RequestInit, attempts = 3) {
  const method = init?.method?.toUpperCase() ?? "GET";
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      if ((method !== "GET" && method !== "HEAD") || !isRetryableLocalFetchError(error)) {
        throw error;
      }
      if (attempt === attempts) {
        throw error;
      }
      await sleep(10);
    }
  }
  throw lastError;
}

async function waitForRunnerCatalog(baseUrl: string, timeoutMs = 5_000) {
  let catalog:
    | {
        status: "loading" | "ready" | "failed";
        real: Array<{ key: string; name: string }>;
      }
    | undefined;
  await vi.waitFor(
    async () => {
      const response = await fetchWithRetry(`${baseUrl}/api/bootstrap`);
      const bootstrap = (await response.json()) as {
        runnerCatalog: {
          status: "loading" | "ready" | "failed";
          real: Array<{ key: string; name: string }>;
        };
      };
      if (bootstrap.runnerCatalog.status === "loading") {
        throw new Error("runner catalog still loading");
      }
      catalog = bootstrap.runnerCatalog;
    },
    { interval: 1, timeout: timeoutMs },
  );
  if (!catalog) {
    throw new Error("runner catalog stayed loading");
  }
  return catalog;
}

async function waitForFileContent(filePath: string, expected: string, timeoutMs = 5_000) {
  let content: string | undefined;
  await vi.waitFor(
    async () => {
      try {
        content = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (content !== expected) {
        throw new Error(`file did not reach expected content: ${filePath}`);
      }
    },
    { interval: 1, timeout: timeoutMs },
  );
  if (content === undefined) {
    throw new Error(`file did not reach expected content: ${filePath}`);
  }
  return content;
}

async function expectFileMissing(filePath: string): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected file to be missing: ${filePath}`);
}

async function createQaLabRepoRootFixture(params?: {
  uiHtml?: string;
  models?: Array<{
    key: string;
    name: string;
    input?: string;
    available?: boolean;
    missing?: boolean;
  }>;
}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-lab-repo-root-"));
  cleanups.push(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(repoRoot, "dist"), { recursive: true });
  await mkdir(path.join(repoRoot, "extensions/qa-lab/web/dist"), { recursive: true });
  const models =
    params?.models?.map((model) => ({
      key: model.key,
      name: model.name,
      input: model.input ?? model.key,
      available: model.available ?? true,
      missing: model.missing ?? false,
    })) ?? [];
  await writeFile(
    path.join(repoRoot, "dist/index.js"),
    `process.stdout.write(${JSON.stringify(JSON.stringify({ models }))});\n`,
    "utf8",
  );
  await writeFile(
    path.join(repoRoot, "extensions/qa-lab/web/dist/index.html"),
    params?.uiHtml ?? "<!doctype html><html><body>qa lab fixture</body></html>",
    "utf8",
  );
  return repoRoot;
}

type QaLabSuiteScenarioFixture = {
  name: string;
  status: "pass" | "fail" | "skip";
  steps: unknown[];
  details?: string;
};

async function createQaLabSuiteResultFixture(params?: {
  scenarios?: QaLabSuiteScenarioFixture[];
  watchUrl?: string;
}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-suite-result-"));
  cleanups.push(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });
  const scenarios = params?.scenarios ?? [
    { name: "Channel chat baseline", status: "pass" as const, steps: [] },
  ];
  const report = "# QA report\n";
  const evidencePath = path.join(outputDir, "qa-evidence.json");
  const reportPath = path.join(outputDir, "qa-suite-report.md");
  const summaryPath = path.join(outputDir, "qa-suite-summary.json");
  await Promise.all([
    writeFile(
      evidencePath,
      JSON.stringify({
        entries: scenarios.map((scenario) => ({ result: { status: scenario.status } })),
      }),
      "utf8",
    ),
    writeFile(reportPath, report, "utf8"),
    writeFile(
      summaryPath,
      JSON.stringify({
        run: { status: "completed" },
        counts: {
          total: scenarios.length,
          passed: scenarios.filter((scenario) => scenario.status === "pass").length,
          failed: scenarios.filter((scenario) => scenario.status === "fail").length,
          skipped: scenarios.filter((scenario) => scenario.status === "skip").length,
        },
        scenarios,
      }),
      "utf8",
    ),
  ]);
  return {
    evidencePath,
    outputDir,
    report,
    reportPath,
    scenarios,
    summaryPath,
    ...(params?.watchUrl ? { watchUrl: params.watchUrl } : {}),
  };
}

describe("qa-lab server", () => {
  it("returns reachable IPv6 listen and advertised URLs", async () => {
    const lab = await startQaLabServerForTest({ host: "::1", port: 0 });
    cleanups.push(async () => await lab.stop());

    for (const baseUrl of [lab.listenUrl, lab.baseUrl]) {
      const response = await fetch(`${baseUrl}/healthz`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, status: "live" });
    }
  });

  it("returns a 500 JSON response when a shared bus route rejects", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => await lab.stop());
    const requestError = new Error("combined snapshot unavailable");
    lab.state.getSnapshot = () => {
      throw requestError;
    };

    const response = await fetch(`${lab.baseUrl}/v1/state`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: requestError.message });
  });

  it("dispatches explicit mixed-kind selections through the suite planner", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });
    suiteLaunchMock.runQaSuite.mockResolvedValue({
      executionKind: "suite",
      expectedCells: [],
      observedCells: [],
      result: await createQaLabSuiteResultFixture(),
    });

    const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelDriver: "crabline",
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      }),
    });

    expect(response.status).toBe(202);
    const launch = (await response.json()) as {
      plan: {
        executionKinds: string[];
        selectedScenarios: Array<{
          id: string;
          declaredChannel: string | null;
          effectiveChannel: string | null;
        }>;
      };
    };
    expect(launch.plan.executionKinds).toEqual(["flow", "playwright"]);
    expect(launch.plan.selectedScenarios.map((scenario) => scenario.id)).toEqual([
      "dm-chat-baseline",
      "browser-talk-start-stop",
    ]);
    expect(launch.plan.selectedScenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dm-chat-baseline",
          declaredChannel: null,
          effectiveChannel: "telegram",
        }),
        expect.objectContaining({
          id: "browser-talk-start-stop",
          declaredChannel: null,
          effectiveChannel: null,
        }),
      ]),
    );
    await vi.waitFor(() => expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1));
    expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        alternateModel: "openai/gpt-5.6-luna",
        channelDriver: "crabline",
        controlUiEnabled: true,
        primaryModel: "openai/gpt-5.6-luna",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      }),
    );
    expect(liveTransportMock.listAdapterFactories).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const bootstrap = (await (await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)).json()) as {
        runner: {
          status: string;
          selection: { scenarioIds: string[] };
          artifacts: { watchUrl: string };
        };
      };
      expect(bootstrap.runner.status).toBe("completed");
      expect(bootstrap.runner.artifacts.watchUrl).toBe(lab.baseUrl);
      expect(bootstrap.runner.selection.scenarioIds).toEqual([
        "dm-chat-baseline",
        "browser-talk-start-stop",
      ]);
    });
  });

  it.each([
    { label: "failed", status: "fail" as const },
    { label: "skipped", status: "skip" as const },
  ])(
    "marks $label suite results failed while preserving generated artifacts",
    async ({ status }) => {
      const lab = await startQaLabServerForTest();
      cleanups.push(async () => {
        await lab.stop();
      });
      const result = await createQaLabSuiteResultFixture({
        scenarios: [{ name: "Channel chat baseline", status, steps: [] }],
      });
      suiteLaunchMock.runQaSuite.mockResolvedValue({
        executionKind: "flow",
        expectedCells: [],
        observedCells: [],
        result,
      });

      const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelDriver: "crabline",
          providerMode: "live-frontier",
          scenarioIds: ["dm-chat-baseline"],
        }),
      });

      expect(response.status).toBe(202);
      await vi.waitFor(async () => {
        const bootstrap = (await (await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)).json()) as {
          latestReport: { outputPath: string; markdown: string };
          runner: {
            status: string;
            error: string;
            artifacts: {
              outputDir: string;
              evidencePath: string;
              reportPath: string;
              summaryPath: string;
            };
          };
        };
        expect(bootstrap.runner.status).toBe("failed");
        expect(bootstrap.runner.error).toBe("QA suite reported 1 failed or skipped scenario(s).");
        expect(bootstrap.runner.artifacts).toEqual(
          expect.objectContaining({
            outputDir: result.outputDir,
            evidencePath: result.evidencePath,
            reportPath: result.reportPath,
            summaryPath: result.summaryPath,
          }),
        );
        expect(bootstrap.latestReport).toEqual(
          expect.objectContaining({ outputPath: result.reportPath, markdown: result.report }),
        );
      });
    },
  );

  it.each([
    {
      label: "invalid",
      summary: "{invalid-summary",
      expectedError: "Could not parse QA summary JSON",
    },
    {
      label: "empty",
      summary: JSON.stringify({
        run: { status: "completed" },
        counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
        scenarios: [],
      }),
      expectedError: "did not include any executed scenarios",
    },
  ])(
    "fails closed on an $label suite summary while preserving artifacts",
    async (invalidResult) => {
      const lab = await startQaLabServerForTest();
      cleanups.push(async () => {
        await lab.stop();
      });
      const result = await createQaLabSuiteResultFixture();
      await writeFile(result.summaryPath, invalidResult.summary, "utf8");
      suiteLaunchMock.runQaSuite.mockResolvedValue({
        executionKind: "flow",
        expectedCells: [],
        observedCells: [],
        result,
      });

      const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelDriver: "crabline",
          providerMode: "live-frontier",
          scenarioIds: ["dm-chat-baseline"],
        }),
      });

      expect(response.status).toBe(202);
      await vi.waitFor(async () => {
        const bootstrap = (await (await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)).json()) as {
          runner: { status: string; error: string; artifacts: { summaryPath: string } };
        };
        expect(bootstrap.runner.status).toBe("failed");
        expect(bootstrap.runner.error).toContain(invalidResult.expectedError);
        expect(bootstrap.runner.artifacts.summaryPath).toBe(result.summaryPath);
      });
    },
  );

  it("keeps implicit suites green for catalog-verified report-only optional skips", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });
    const result = await createQaLabSuiteResultFixture({
      scenarios: [
        { name: "Channel chat baseline", status: "pass", steps: [] },
        {
          name: "Runtime tool fixture — image_generate",
          status: "skip",
          steps: [],
          details: "image_generate mock provider report-only: tool unavailable",
        },
      ],
    });
    suiteLaunchMock.runQaSuite.mockResolvedValue({
      executionKind: "flow",
      expectedCells: [],
      observedCells: [],
      result,
    });

    const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "all",
        channelDriver: "crabline",
        providerMode: "live-frontier",
      }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      const bootstrap = (await (await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)).json()) as {
        runner: { status: string; error: string | null };
      };
      expect(bootstrap.runner.status).toBe("completed");
      expect(bootstrap.runner.error).toBeNull();
    });
  });

  it("keeps mock providers independent from real channel adapters", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });
    suiteLaunchMock.runQaSuite.mockResolvedValue({
      executionKind: "flow",
      expectedCells: [],
      observedCells: [],
      result: await createQaLabSuiteResultFixture({ watchUrl: "http://runtime-watch.invalid" }),
    });

    const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelDriver: "live",
        providerMode: "mock-openai",
        scenarioIds: ["dm-chat-baseline"],
      }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1));
    expect(liveTransportMock.listAdapterFactories).toHaveBeenCalledTimes(1);
    expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories: liveTransportMock.adapterFactories,
        channelDriver: "live",
        providerMode: "mock-openai",
      }),
    );
    await vi.waitFor(async () => {
      const bootstrap = (await (await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)).json()) as {
        runner: { status: string; artifacts: { watchUrl: string } };
      };
      expect(bootstrap.runner.status).toBe("completed");
      expect(bootstrap.runner.artifacts.watchUrl).toBe("http://runtime-watch.invalid");
    });
  });

  it("launches a plural-only catalog scenario on its selected live channel", async () => {
    liveTransportMock.adapterFactories[0]!.matches.mockReturnValue(true);
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });
    suiteLaunchMock.runQaSuite.mockResolvedValue({
      executionKind: "flow",
      expectedCells: [],
      observedCells: [],
      result: await createQaLabSuiteResultFixture(),
    });

    const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "all",
        channel: "buzz",
        channelDriver: "live",
        providerMode: "mock-openai",
        scenarioIds: ["channel-canary"],
      }),
    });

    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      plan: {
        selectedScenarios: Array<{
          id: string;
          declaredChannel: string | null;
          effectiveChannel: string | null;
        }>;
      };
    };
    expect(payload.plan.selectedScenarios).toEqual([
      expect.objectContaining({
        id: "channel-canary",
        declaredChannel: null,
        effectiveChannel: "buzz",
      }),
    ]);
    await vi.waitFor(() => expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1));
    expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        channelDriver: "live",
        channelId: "buzz",
        scenarioIds: ["channel-canary"],
      }),
    );
  });

  it("allows only one concurrent request to commit a resolved suite plan", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });
    let finishSuite: ((value: unknown) => void) | undefined;
    suiteLaunchMock.runQaSuite.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSuite = resolve;
        }),
    );
    const request = () =>
      fetch(`${lab.baseUrl}/api/scenario/suite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelDriver: "crabline",
          providerMode: "live-frontier",
          scenarioIds: ["dm-chat-baseline"],
        }),
      });

    const responses = await Promise.all([request(), request()]);

    expect(
      responses.map((response) => response.status).toSorted((left, right) => left - right),
    ).toEqual([202, 409]);
    expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1);
    finishSuite?.({
      executionKind: "flow",
      expectedCells: [],
      observedCells: [],
      result: await createQaLabSuiteResultFixture(),
    });
    await vi.waitFor(async () => {
      const bootstrap = (await (await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)).json()) as {
        runner: { status: string };
      };
      expect(bootstrap.runner.status).toBe("completed");
    });
  });

  it("rejects empty and unknown explicit selections before dispatch", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });
    for (const scenarioIds of [[], ["missing-scenario"]]) {
      const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioIds }),
      });
      expect(response.status).toBe(400);
    }
    expect(suiteLaunchMock.runQaSuite).not.toHaveBeenCalled();
  });

  it("returns the resolved runtime-pair-lane plan and launches it with independent live transport", async () => {
    liveTransportMock.adapterFactories[0]!.matches.mockReturnValue(true);
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });
    suiteLaunchMock.runQaSuite.mockResolvedValue({
      executionKind: "flow",
      expectedCells: [],
      observedCells: [],
      result: await createQaLabSuiteResultFixture({ watchUrl: lab.baseUrl }),
    });

    const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "all",
        channel: "telegram",
        channelDriver: "live",
        evidenceMode: "slim",
        providerMode: "mock-openai",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
      }),
    });

    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      plan: {
        executionKinds: string[];
        exclusions: Array<{ scenarioId: string }>;
        selectedScenarios: Array<{ id: string }>;
      };
    };
    expect(payload.plan.executionKinds).toEqual(["flow"]);
    expect(payload.plan.selectedScenarios.map((scenario) => scenario.id)).toContain(
      "runtime-first-hour-20-turn",
    );
    expect(payload.plan.exclusions.map((exclusion) => exclusion.scenarioId)).toContain(
      "codex-plugin-cold-install",
    );
    await vi.waitFor(() => expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1));
    expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories: liveTransportMock.adapterFactories,
        channelDriver: "live",
        channelId: "telegram",
        evidenceMode: "slim",
        providerMode: "mock-openai",
        runtimePair: ["openclaw", "codex"],
      }),
    );
  });

  it("returns explicit exclusions and errors without launching unsupported execution kinds", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });

    const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "all",
        channelDriver: "qa-channel",
        providerMode: "live-frontier",
        runtimePair: ["openclaw", "codex"],
        scenarioIds: ["browser-talk-start-stop"],
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: string;
      plan: {
        status: string;
        exclusions: Array<{ scenarioId: string; reasons: string[] }>;
        errors: string[];
      };
    };
    expect(payload.plan.status).toBe("invalid");
    expect(payload.plan.exclusions).toEqual([
      expect.objectContaining({
        scenarioId: "browser-talk-start-stop",
        reasons: ["runtimePair requires execution.kind=flow"],
      }),
    ]);
    expect(payload.error).toContain("Explicit QA scenario selection is not runnable");
    expect(suiteLaunchMock.runQaSuite).not.toHaveBeenCalled();
  });

  it("enforces explicit execution.channel through the shared suite channel planner", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });

    const response = await fetch(`${lab.baseUrl}/api/scenario/suite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "all",
        channel: "telegram",
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["matrix-room-block-streaming"],
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      plan: { exclusions: Array<{ scenarioId: string; reasons: string[] }> };
    };
    expect(payload.plan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenarioId: "matrix-room-block-streaming" }),
      ]),
    );
    expect(suiteLaunchMock.runQaSuite).not.toHaveBeenCalled();
  });

  it("does not open capture state when embedded gateway setup fails", async () => {
    qaChannelMock.resolveAccount.mockImplementationOnce(() => {
      throw new Error("embedded setup failed");
    });

    await expect(
      startQaLabServer({
        host: "127.0.0.1",
        port: 0,
      }),
    ).rejects.toThrow("embedded setup failed");

    expect(captureMock.acquire).not.toHaveBeenCalled();
    expect(captureMock.store.close).not.toHaveBeenCalled();
  });

  it("closes the server and acquired capture state when embedded gateway stop fails", async () => {
    qaChannelMock.startAccount.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        await new Promise<void>((_resolve, reject) => {
          if (!abortSignal) {
            return;
          }
          if (abortSignal.aborted) {
            reject(new Error("gateway stop failed"));
            return;
          }
          abortSignal.addEventListener("abort", () => reject(new Error("gateway stop failed")), {
            once: true,
          });
        }),
    );

    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
    });
    await fetchWithRetry(`${lab.baseUrl}/api/capture/sessions`);

    await expect(lab.stop()).rejects.toThrow("gateway stop failed");

    expect(captureMock.acquire).toHaveBeenCalledTimes(1);
    expect(captureMock.store.close).toHaveBeenCalledTimes(1);
    await expect(fetch(`${lab.baseUrl}/healthz`)).rejects.toThrow();
  });

  it("keeps the bus available until the embedded gateway finishes stopping", async () => {
    let markGatewayStopping = () => {};
    const gatewayStopping = new Promise<void>((resolve) => {
      markGatewayStopping = resolve;
    });
    let finishGatewayStop = () => {};
    const gatewayStopped = new Promise<void>((resolve) => {
      finishGatewayStop = resolve;
    });
    qaChannelMock.startAccount.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        markGatewayStopping();
        await gatewayStopped;
      },
    );

    const lab = await startQaLabServer({ host: "127.0.0.1", port: 0 });
    const waitForCursorAdvance = lab.state.waitForCursorAdvance.bind(lab.state);
    let pollWaiterStarted = false;
    let pollWaiterSettled = false;
    lab.state.waitForCursorAdvance = async (...args) => {
      pollWaiterStarted = true;
      try {
        return await waitForCursorAdvance(...args);
      } finally {
        pollWaiterSettled = true;
      }
    };
    const poll = fetch(`${lab.listenUrl}/v1/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "cleanup", cursor: 0, timeoutMs: 30_000 }),
    }).catch(() => undefined);
    const inboundBody = JSON.stringify({
      conversation: { id: "late-room", kind: "direct" },
      senderId: "late-sender",
      text: "must not survive shutdown",
    });
    const slowInbound = httpRequest(new URL("/api/inbound/message", lab.listenUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(inboundBody),
      },
    });
    slowInbound.on("response", (response) => response.resume());
    slowInbound.on("error", () => undefined);
    slowInbound.write(inboundBody.slice(0, 1));
    await vi.waitFor(() => expect(pollWaiterStarted).toBe(true));
    const stopping = lab.stop();
    await gatewayStopping;
    try {
      await expect(fetch(`${lab.baseUrl}/healthz`)).resolves.toMatchObject({ status: 200 });
      expect(pollWaiterSettled).toBe(false);
    } finally {
      finishGatewayStop();
      setTimeout(() => slowInbound.end(inboundBody.slice(1)), 50);
      await stopping;
    }
    await poll;
    expect(pollWaiterSettled).toBe(true);
    expect(lab.state.getSnapshot()).toMatchObject({ events: [], messages: [] });
    await expect(fetch(`${lab.baseUrl}/healthz`)).rejects.toThrow();
  });

  it("serves bootstrap state and message state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-test-"));
    cleanups.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const outputPath = path.join(tempDir, "self-check.md");
    const repoRoot = await createQaLabRepoRootFixture();

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      outputPath,
      repoRoot,
      controlUiUrl:
        "https://gateway.example.test/?token=qa-token&api_key=qa-api-key&id_token=qa-id-token&panel=chat#token=fragment-token",
      embeddedGateway: "disabled",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const bootstrapResponse = await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = (await bootstrapResponse.json()) as {
      controlUiUrl: string | null;
      controlUiEmbeddedUrl: string | null;
      kickoffTask: string;
      scenarios: Array<{ id: string; title: string; execution?: { kind?: string } }>;
      defaults: { conversationId: string; senderId: string };
      runner: { status: string; selection: { providerMode: string; scenarioIds: string[] | null } };
      runnerCatalog: { channels: string[]; profiles: Array<{ id: string }> };
    };
    expect(bootstrap.defaults.conversationId).toBe("qa-operator");
    expect(bootstrap.defaults.senderId).toBe("qa-operator");
    expect(bootstrap.controlUiUrl).toBe("https://gateway.example.test/?panel=chat");
    expect(bootstrap.controlUiEmbeddedUrl).toBe("https://gateway.example.test/?panel=chat");
    expect(bootstrap.kickoffTask).toContain("Lobster Invaders");
    expect(bootstrap.scenarios.length).toBeGreaterThanOrEqual(10);
    expect(bootstrap.scenarios.map((scenario) => scenario.id)).toContain("dm-chat-baseline");
    expect(bootstrap.runner.status).toBe("idle");
    expect(bootstrap.runner.selection.providerMode).toBe("mock-openai");
    expect(bootstrap.runner.selection.scenarioIds).toBeNull();
    expect(bootstrap.runnerCatalog.profiles.map((profile) => profile.id)).toEqual([
      "smoke-ci",
      "personal-agent",
      "observability",
      "release",
      "all",
    ]);
    expect(bootstrap.runnerCatalog.channels).toEqual([
      "buzz",
      "discord",
      "matrix",
      "msteams",
      "qa-channel",
      "slack",
      "telegram",
      "whatsapp",
    ]);

    const startupStatus = (await (
      await fetchWithRetry(`${lab.baseUrl}/api/capture/startup-status`)
    ).json()) as {
      status: { gateway: { url: string } };
    };
    expect(startupStatus.status.gateway.url).toBe("https://gateway.example.test/?panel=chat");

    lab.setControlUi({
      controlUiUrl:
        "/control-ui/?token=late-token&api_key=late-api-key&id_token=late-id-token&panel=chat#token=fragment-token",
    });
    const relativeBootstrap = (await (
      await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)
    ).json()) as {
      controlUiUrl: string | null;
      controlUiEmbeddedUrl: string | null;
    };
    expect(relativeBootstrap.controlUiUrl).toBe("/control-ui/?panel=chat");
    expect(relativeBootstrap.controlUiEmbeddedUrl).toBe("/control-ui/?panel=chat");

    const messageResponse = await fetch(`${lab.baseUrl}/api/inbound/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversation: { id: "bob", kind: "direct" },
        senderId: "bob",
        senderName: "Bob",
        text: "hello from test",
      }),
    });
    expect(messageResponse.status).toBe(200);

    const stateResponse = await fetchWithRetry(`${lab.baseUrl}/api/state`);
    expect(stateResponse.status).toBe(200);
    const snapshot = (await stateResponse.json()) as {
      messages: Array<{ direction: string; text: string }>;
    };
    expect(snapshot.messages.map((message) => message.text)).toContain("hello from test");

    await expectFileMissing(outputPath);
  });

  it("serves evidence artifact HEAD metadata and streams GET bodies", async () => {
    const repoRoot = await createQaLabRepoRootFixture();
    const evidenceDir = path.join(repoRoot, ".artifacts", "qa-e2e", "server");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "artifact.log"), "streamed body\n", "utf8");
    await writeFile(
      path.join(evidenceDir, "qa-evidence.json"),
      `${JSON.stringify(
        {
          kind: "openclaw.qa.evidence-summary",
          schemaVersion: 2,
          generatedAt: "2026-06-17T12:00:00.000Z",
          evidenceMode: "full",
          entries: [
            {
              test: {
                kind: "vitest-test",
                id: "qa-lab.server-artifact",
                title: "Server artifact",
              },
              coverage: [{ id: "qa.artifact", role: "primary" }],
              execution: {
                runner: "vitest",
                environment: {
                  ref: "server-test",
                  os: "darwin",
                  nodeVersion: "v24.0.0",
                },
                provider: {
                  id: "mock-openai",
                  live: false,
                  model: { name: "mock-openai/gpt-5.6-luna", ref: "mock-openai/gpt-5.6-luna" },
                },
                packageSource: { kind: "source-checkout" },
                artifacts: [{ kind: "log", path: "artifact.log", source: "vitest" }],
              },
              result: { status: "pass" },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      repoRoot,
    });
    cleanups.push(async () => {
      await lab.stop();
    });
    const evidenceUrl = new URL("/api/evidence", lab.baseUrl);
    evidenceUrl.searchParams.set("path", ".artifacts/qa-e2e/server/qa-evidence.json");

    const evidenceResponse = await fetchWithRetry(evidenceUrl.toString());
    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.headers.get("cache-control")).toBe("no-store");
    expect((await evidenceResponse.json()) as unknown).toMatchObject({
      evidence: {
        counts: {
          pass: 1,
        },
        entries: [{ id: "qa-lab.server-artifact" }],
      },
    });

    // A missing evidence path must return a controlled JSON error, not a reset connection
    // (the model must build before any success header is written).
    const missingEvidenceUrl = new URL("/api/evidence", lab.baseUrl);
    missingEvidenceUrl.searchParams.set("path", ".artifacts/qa-e2e/server/does-not-exist.json");
    const missingEvidenceResponse = await fetchWithRetry(missingEvidenceUrl.toString());
    expect(missingEvidenceResponse.status).toBe(404);
    expect(await missingEvidenceResponse.text()).not.toBe("");

    const artifactUrl = new URL("/api/evidence/artifact", lab.baseUrl);
    artifactUrl.searchParams.set("evidencePath", ".artifacts/qa-e2e/server/qa-evidence.json");
    artifactUrl.searchParams.set("artifactPath", "artifact.log");

    const headResponse = await fetchWithRetry(artifactUrl.toString(), { method: "HEAD" });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(headResponse.headers.get("content-length")).toBe("14");
    expect(headResponse.headers.get("cache-control")).toBe("no-store");
    expect(headResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await headResponse.text()).toBe("");

    const getResponse = await fetchWithRetry(artifactUrl.toString());
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-length")).toBe("14");
    expect(getResponse.headers.get("cache-control")).toBe("no-store");
    expect(getResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await getResponse.text()).toBe("streamed body\n");

    const indexedArtifactUrl = new URL("/api/evidence/artifact", lab.baseUrl);
    indexedArtifactUrl.searchParams.set(
      "evidencePath",
      ".artifacts/qa-e2e/server/qa-evidence.json",
    );
    indexedArtifactUrl.searchParams.set("entryIndex", "0");
    indexedArtifactUrl.searchParams.set("artifactIndex", "0");
    const indexedResponse = await fetchWithRetry(indexedArtifactUrl.toString());
    expect(indexedResponse.status).toBe(200);
    expect(await indexedResponse.text()).toBe("streamed body\n");

    const hexIndexUrl = new URL(indexedArtifactUrl);
    hexIndexUrl.searchParams.set("entryIndex", "0x0");
    const hexIndexResponse = await fetchWithRetry(hexIndexUrl.toString());
    expect(hexIndexResponse.status).toBe(400);

    const exponentIndexUrl = new URL(indexedArtifactUrl);
    exponentIndexUrl.searchParams.set("artifactIndex", "1e0");
    const exponentIndexResponse = await fetchWithRetry(exponentIndexUrl.toString());
    expect(exponentIndexResponse.status).toBe(400);

    const leadingZeroIndexUrl = new URL(indexedArtifactUrl);
    leadingZeroIndexUrl.searchParams.set("entryIndex", "00");
    const leadingZeroIndexResponse = await fetchWithRetry(leadingZeroIndexUrl.toString());
    expect(leadingZeroIndexResponse.status).toBe(400);

    const whitespaceIndexUrl = new URL(indexedArtifactUrl);
    whitespaceIndexUrl.searchParams.set("entryIndex", " 0 ");
    const whitespaceIndexResponse = await fetchWithRetry(whitespaceIndexUrl.toString());
    expect(whitespaceIndexResponse.status).toBe(400);

    await writeFile(path.join(evidenceDir, "undeclared.log"), "hidden\n", "utf8");
    const undeclaredUrl = new URL(artifactUrl);
    undeclaredUrl.searchParams.set("artifactPath", "undeclared.log");
    const undeclaredResponse = await fetchWithRetry(undeclaredUrl.toString());
    expect(undeclaredResponse.status).toBe(403);

    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-outside-artifact-"));
    cleanups.push(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });
    const outsideArtifact = path.join(outsideDir, "outside.log");
    await writeFile(outsideArtifact, "outside\n", "utf8");
    const outsideUrl = new URL(artifactUrl);
    outsideUrl.searchParams.set("artifactPath", outsideArtifact);
    const outsideResponse = await fetchWithRetry(outsideUrl.toString());
    expect(outsideResponse.status).toBe(404);
  });

  it("preserves UTF-8 at the evidence preview byte boundary", async () => {
    const repoRoot = await createQaLabRepoRootFixture();
    const evidenceDir = path.join(repoRoot, ".artifacts", "qa-e2e", "utf8-preview");
    const previewBytes = 12 * 1024;
    const shortReadBytes = 1024;
    const readBoundaryPrefix = "a".repeat(shortReadBytes - 1);
    const readBoundaryText = `${readBoundaryPrefix}😀tail`;
    const splitPrefix = "a".repeat(previewBytes - 1);
    const completePrefix = "a".repeat(previewBytes - Buffer.byteLength("😀"));
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "short-read.log"), readBoundaryText, "utf8");
    await writeFile(path.join(evidenceDir, "split.log"), `${splitPrefix}😀tail`, "utf8");
    await writeFile(path.join(evidenceDir, "complete.log"), `${completePrefix}😀tail`, "utf8");
    await writeFile(
      path.join(evidenceDir, "qa-evidence.json"),
      `${JSON.stringify(
        {
          kind: "openclaw.qa.evidence-summary",
          schemaVersion: 2,
          generatedAt: "2026-07-16T00:00:00.000Z",
          evidenceMode: "full",
          entries: [
            {
              test: {
                kind: "vitest-test",
                id: "qa-lab.utf8-preview-boundary",
                title: "UTF-8 preview boundary",
              },
              coverage: [{ id: "qa.evidence-preview", role: "primary" }],
              execution: {
                runner: "vitest",
                environment: {
                  ref: "utf8-preview-test",
                  os: process.platform,
                  nodeVersion: process.version,
                },
                provider: {
                  id: "mock-openai",
                  live: false,
                  model: { name: "mock-openai/gpt-5.6-luna", ref: "mock-openai/gpt-5.6-luna" },
                },
                packageSource: { kind: "source-checkout" },
                artifacts: [
                  { kind: "log", path: "short-read.log", source: "vitest" },
                  { kind: "log", path: "split.log", source: "vitest" },
                  { kind: "log", path: "complete.log", source: "vitest" },
                ],
              },
              result: { status: "pass" },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const realOpen = fs.open;
    const readPositions = new Map<string, number[]>();
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await realOpen(filePath, flags, mode);
      const realRead = handle.read.bind(handle);
      const artifactName = path.basename(filePath.toString());
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const positions = readPositions.get(artifactName) ?? [];
          positions.push(position);
          readPositions.set(artifactName, positions);
          return await realRead(buffer, offset, Math.min(length, shortReadBytes), position);
        },
      });
      return handle;
    });
    cleanups.push(async () => {
      openSpy.mockRestore();
    });

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      repoRoot,
    });
    cleanups.push(async () => {
      await lab.stop();
    });
    const evidenceUrl = new URL("/api/evidence", lab.baseUrl);
    evidenceUrl.searchParams.set("path", ".artifacts/qa-e2e/utf8-preview/qa-evidence.json");

    const response = await fetchWithRetry(evidenceUrl.toString());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      evidence: { entries: Array<{ artifacts: Array<{ path: string; preview: string | null }> }> };
    };
    const artifacts = payload.evidence.entries[0]?.artifacts ?? [];
    const shortRead = artifacts.find((artifact) => artifact.path.endsWith("short-read.log"));
    const split = artifacts.find((artifact) => artifact.path.endsWith("split.log"));
    const complete = artifacts.find((artifact) => artifact.path.endsWith("complete.log"));
    expect(shortRead?.preview).toBe(readBoundaryText);
    expect(split?.preview).toBe(splitPrefix);
    expect(complete?.preview).toBe(`${completePrefix}😀`);
    expect(readPositions.get("short-read.log")?.slice(0, 2)).toEqual([0, shortReadBytes]);
    expect(readPositions.get("short-read.log")?.at(-1)).toBe(Buffer.byteLength(readBoundaryText));
    expect(JSON.stringify(payload)).not.toContain("�");
  });

  it("returns controlled errors for malformed JSON body reads", async () => {
    const lab = await startQaLabServerForTest();
    cleanups.push(async () => {
      await lab.stop();
    });

    const response = await fetch(`${lab.baseUrl}/api/inbound/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Malformed JSON body",
    });
  });

  it("anchors direct self-check runs under the explicit repo root by default", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-lab-self-check-root-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      repoRoot,
      embeddedGateway: "disabled",
      selfCheckWaitTimeoutMs: 1,
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const result = await lab.runSelfCheck();
    expect(path.dirname(result.outputPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(result.outputPath)).toMatch(/^self-check-[a-z0-9]+-[a-f0-9]{8}\.md$/u);
    expect(await readFile(result.outputPath, "utf8")).toContain("Synthetic Slack-class roundtrip");
  });

  it("injects the kickoff task on demand and on startup", async () => {
    const autoKickoffLab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
      sendKickoffOnStart: true,
    });
    cleanups.push(async () => {
      await autoKickoffLab.stop();
    });

    const autoSnapshot = (await (
      await fetchWithRetry(`${autoKickoffLab.baseUrl}/api/state`)
    ).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(autoSnapshot.messages.map((message) => message.text).join("\n")).toContain(
      "QA mission:",
    );

    const manualLab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    });
    cleanups.push(async () => {
      await manualLab.stop();
    });

    const kickoffResponse = await fetch(`${manualLab.baseUrl}/api/kickoff`, {
      method: "POST",
    });
    expect(kickoffResponse.status).toBe(200);

    const manualSnapshot = (await (
      await fetchWithRetry(`${manualLab.baseUrl}/api/state`)
    ).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(manualSnapshot.messages.map((message) => message.text).join("\n")).toContain(
      "Lobster Invaders",
    );
  });

  it("proxies control-ui paths through /control-ui", async () => {
    const authorizations: Array<string | undefined> = [];
    const upstream = createServer((req, res) => {
      authorizations.push(req.headers.authorization);
      if ((req.url ?? "/") === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "live" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none';",
      });
      res.end("<!doctype html><title>control-ui</title><h1>Control UI</h1>");
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("expected upstream address");
    }

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      advertiseHost: "127.0.0.1",
      advertisePort: 43124,
      controlUiProxyTarget: `http://127.0.0.1:${address.port}/`,
      controlUiProxyToken: "proxy-token",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const bootstrap = (await (await fetchWithRetry(`${lab.listenUrl}/api/bootstrap`)).json()) as {
      controlUiUrl: string | null;
      controlUiEmbeddedUrl: string | null;
    };
    expect(bootstrap.controlUiUrl).toBe("http://127.0.0.1:43124/control-ui/");
    expect(bootstrap.controlUiEmbeddedUrl).toBe("http://127.0.0.1:43124/control-ui/");

    const healthResponse = await fetchWithRetry(`${lab.listenUrl}/control-ui/healthz`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ ok: true, status: "live" });

    const rootResponse = await fetchWithRetry(`${lab.listenUrl}/control-ui/`);
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("x-frame-options")).toBeNull();
    expect(rootResponse.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(await rootResponse.text()).toContain("Control UI");
    expect(authorizations).toEqual(["Bearer proxy-token", "Bearer proxy-token"]);
  });

  it("serves the built QA UI bundle when available", async () => {
    const uiDistDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-dist-"));
    cleanups.push(async () => {
      await rm(uiDistDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      uiDistDir,
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const rootResponse = await fetchWithRetry(`${lab.baseUrl}/`);
    expect(rootResponse.status).toBe(200);
    const html = await rootResponse.text();
    expect(html).not.toContain("QA Lab UI not built");
    expect(html).toContain("<title>");
  });

  it("uses the explicit repo root for ui assets and runner model discovery", async () => {
    const repoRoot = await createQaLabRepoRootFixture({
      models: [
        {
          key: "anthropic/qa-temp-model",
          name: "QA Temp Model",
        },
      ],
      uiHtml:
        "<!doctype html><html><head><title>Temp QA Lab UI</title></head><body>repo-root-ui</body></html>",
    });

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      repoRoot,
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const rootResponse = await fetchWithRetry(`${lab.baseUrl}/`);
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain("repo-root-ui");

    const versionResponse = await fetchWithRetry(`${lab.baseUrl}/api/ui-version`);
    expect(versionResponse.status).toBe(200);
    const versionPayload = (await versionResponse.json()) as { version?: string | null };
    expect(versionPayload.version).toBe(resolveUiAssetVersion(null, repoRoot));
    expect(versionPayload.version).toMatch(/^[0-9a-f]{12}$/);

    const runnerCatalog = await waitForRunnerCatalog(lab.baseUrl);
    expect(runnerCatalog.status).toBe("ready");
    const tempModel = runnerCatalog.real.find((model) => model.key === "anthropic/qa-temp-model");
    expect(tempModel?.name).toBe("QA Temp Model");
  });

  it("does not eagerly load the runner model catalog before bootstrap is requested", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-lab-lazy-catalog-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    const markerPath = path.join(repoRoot, "runner-catalog-hit.txt");

    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "extensions/qa-lab/web/dist"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist/index.js"),
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join(" "), "utf8");`,
        "process.stdout.write(JSON.stringify({",
        "  models: [{",
        '    key: "openai/gpt-5.6-luna",',
        '    name: "GPT-5.6 Luna",',
        '    input: "openai/gpt-5.6-luna",',
        "    available: true,",
        "    missing: false,",
        "  }],",
        "}));",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "extensions/qa-lab/web/dist/index.html"),
      "<!doctype html><html><body>lazy catalog</body></html>",
      "utf8",
    );

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      repoRoot,
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    await expectFileMissing(markerPath);

    const bootstrapResponse = await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);

    const runnerCatalog = await waitForRunnerCatalog(lab.baseUrl);
    expect(runnerCatalog.status).toBe("ready");
    expect(await readFile(markerPath, "utf8")).toContain("models list --all --json");
  });

  it("aborts an in-flight runner model catalog when the lab stops", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-lab-abort-catalog-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    const markerPath = path.join(repoRoot, "runner-catalog-started.txt");
    const stoppedPath = path.join(repoRoot, "runner-catalog-stopped.txt");

    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "extensions/qa-lab/web/dist"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist/index.js"),
      [
        'const fs = require("node:fs");',
        "process.on('SIGTERM', () => {",
        `  fs.writeFileSync(${JSON.stringify(stoppedPath)}, "terminated", "utf8");`,
        "  process.exit(0);",
        "});",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, process.env.OPENCLAW_CODEX_DISCOVERY_LIVE || "", "utf8");`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "extensions/qa-lab/web/dist/index.html"),
      "<!doctype html><html><body>abort catalog</body></html>",
      "utf8",
    );

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      repoRoot,
    });
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) {
        await lab.stop();
      }
    });

    const bootstrapResponse = await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    expect(await waitForFileContent(markerPath, "0")).toBe("0");

    await lab.stop();
    stopped = true;
    if (process.platform !== "win32") {
      expect(await waitForFileContent(stoppedPath, "terminated")).toBe("terminated");
    }
  });

  it("can disable the embedded echo gateway for real-suite runs", async () => {
    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    await fetch(`${lab.baseUrl}/api/inbound/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversation: { id: "bob", kind: "direct" },
        senderId: "bob",
        senderName: "Bob",
        text: "hello from suite",
      }),
    });

    const snapshot = (await (await fetchWithRetry(`${lab.baseUrl}/api/state`)).json()) as {
      messages: Array<{ direction: string }>;
    };
    expect(snapshot.messages.filter((message) => message.direction === "outbound")).toEqual([]);
  });

  it("exposes structured outcomes and can attach control-ui after startup", async () => {
    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const initialOutcomes = (await (
      await fetchWithRetry(`${lab.baseUrl}/api/outcomes`)
    ).json()) as {
      run: unknown;
    };
    expect(initialOutcomes.run).toBeNull();

    lab.setScenarioRun({
      kind: "suite",
      status: "running",
      startedAt: "2026-04-06T09:00:00.000Z",
      scenarios: [
        {
          id: "channel-chat-baseline",
          name: "Channel baseline conversation",
          status: "pass",
          steps: [{ name: "reply check", status: "pass", details: "ok" }],
          finishedAt: "2026-04-06T09:00:01.000Z",
        },
        {
          id: "cron-one-minute-ping",
          name: "Cron one-minute ping",
          status: "running",
          startedAt: "2026-04-06T09:00:02.000Z",
        },
      ],
    });
    lab.setControlUi({
      controlUiUrl: "http://127.0.0.1:18789/?password=late-password#token=late-token",
    });

    const bootstrap = (await (await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`)).json()) as {
      controlUiEmbeddedUrl: string | null;
    };
    expect(bootstrap.controlUiEmbeddedUrl).toBe("http://127.0.0.1:18789/");

    const outcomes = (await (await fetchWithRetry(`${lab.baseUrl}/api/outcomes`)).json()) as {
      run: {
        status: string;
        counts: { total: number; passed: number; running: number };
        scenarios: Array<{ id: string; status: string }>;
      };
    };
    expect(outcomes.run.status).toBe("running");
    expect(outcomes.run.counts).toEqual({
      total: 2,
      pending: 0,
      running: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(outcomes.run.scenarios.map((scenario) => scenario.id)).toEqual([
      "channel-chat-baseline",
      "cron-one-minute-ping",
    ]);
  });

  it("serves proxy capture sessions, events, and query rows", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-capture-"));
    cleanups.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const store = captureMock.store;
    store.upsertSession({
      id: "qa-capture-session",
      startedAt: Date.now(),
      mode: "proxy-run",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
    });
    store.recordEvent({
      sessionId: "qa-capture-session",
      ts: Date.now(),
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-1",
      method: "POST",
      host: "api.example.com",
      path: "/v1/send",
      dataText: '{"hello":"world"}',
      dataSha256: "abc",
      metaJson: JSON.stringify({
        provider: "openai",
        api: "responses",
        model: "gpt-5.6-luna",
        captureOrigin: "shared-fetch",
      }),
    });
    store.recordEvent({
      sessionId: "qa-capture-session",
      ts: Date.now() + 1,
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-2",
      method: "POST",
      host: "api.example.com",
      path: "/v1/send",
      dataText: '{"hello":"world"}',
      dataSha256: "abc",
      metaJson: JSON.stringify({
        provider: "openai",
        api: "responses",
        model: "gpt-5.6-luna",
        captureOrigin: "shared-fetch",
      }),
    });
    store.recordEvent({
      sessionId: "qa-capture-session",
      ts: Date.now() + 2,
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-3",
      method: "POST",
      host: "127.0.0.1:11434",
      path: "/api/chat",
      metaJson: JSON.stringify({
        provider: "ollama",
        model: "kimi-k2.5:cloud",
        captureOrigin: "shared-fetch",
      }),
    });

    const lab = await startQaLabServerForTest({
      host: "127.0.0.1",
      port: 0,
    });
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) {
        await lab.stop();
      }
    });

    await fetchWithRetry(`${lab.baseUrl}/healthz`);
    await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`);
    expect(captureMock.acquire).not.toHaveBeenCalled();

    const sessions = (await (
      await fetchWithRetry(`${lab.baseUrl}/api/capture/sessions`)
    ).json()) as { sessions: Array<{ id: string }> };
    expect(sessions.sessions.map((session) => session.id)).toContain("qa-capture-session");
    expect(captureMock.acquire).toHaveBeenCalledTimes(1);

    const events = (await (
      await fetchWithRetry(`${lab.baseUrl}/api/capture/events?sessionId=qa-capture-session`)
    ).json()) as {
      events: Array<{ flowId: string; provider?: string; model?: string; captureOrigin?: string }>;
    };
    expect(events.events.map((event) => event.flowId)).toContain("flow-1");
    const flow1 = events.events.find((event) => event.flowId === "flow-1");
    expect(flow1?.provider).toBe("openai");
    expect(flow1?.model).toBe("gpt-5.6-luna");
    expect(flow1?.captureOrigin).toBe("shared-fetch");

    const flow3 = events.events.find((event) => event.flowId === "flow-3");
    expect(flow3?.provider).toBe("ollama");
    expect(flow3?.model).toBe("kimi-k2.5:cloud");

    const coverage = (await (
      await fetchWithRetry(`${lab.baseUrl}/api/capture/coverage?sessionId=qa-capture-session`)
    ).json()) as {
      coverage: {
        totalEvents: number;
        unlabeledEventCount: number;
        providers: Array<{ value: string; count: number }>;
        models: Array<{ value: string; count: number }>;
        localPeers: Array<{ value: string; count: number }>;
      };
    };
    expect(coverage.coverage.totalEvents).toBe(3);
    expect(coverage.coverage.unlabeledEventCount).toBe(0);
    expect(coverage.coverage.providers.find((provider) => provider.value === "openai")?.count).toBe(
      2,
    );
    expect(coverage.coverage.providers.find((provider) => provider.value === "ollama")?.count).toBe(
      1,
    );
    expect(coverage.coverage.models.find((model) => model.value === "gpt-5.6-luna")?.count).toBe(2);
    expect(coverage.coverage.models.find((model) => model.value === "kimi-k2.5:cloud")?.count).toBe(
      1,
    );
    expect(
      coverage.coverage.localPeers.find((peer) => peer.value === "127.0.0.1:11434")?.count,
    ).toBe(1);

    const query = (await (
      await fetchWithRetry(
        `${lab.baseUrl}/api/capture/query?sessionId=qa-capture-session&preset=double-sends`,
      )
    ).json()) as { rows: Array<{ host: string; duplicateCount: number }> };
    expect(query.rows).toHaveLength(1);
    expect(query.rows[0]?.host).toBe("api.example.com");
    expect(query.rows[0]?.duplicateCount).toBe(2);
    expect(captureMock.acquire).toHaveBeenCalledTimes(1);

    await lab.stop();
    stopped = true;
    expect(captureMock.store.close).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
