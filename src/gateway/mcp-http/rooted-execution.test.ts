import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import "../../agents/test-helpers/fast-openclaw-tools.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../../agents/cli-runner.test-helpers.js";
import { prepareCliRunContext } from "../../agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../../agents/cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../../agents/cli-runner/types.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  activateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
} from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "../mcp-http.loopback-runtime.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));

type McpResponse = {
  result: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
};

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...buildDefaultTestCliBackend({ bundleMcp: true }),
        autoSelectAuthProfile: false,
        nativeToolMode: "selectable",
        isolatesInstructionsWithExactTools: true,
        toolAvailabilityEnforcement: "prepare-execution",
        prepareExecution: async () => ({ toolAvailabilityEnforced: true }),
      },
    ],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    loadManifestModelCatalog: () => [],
  });
});

afterEach(() => {
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
});

async function withRootedCli(
  run: (fixture: {
    root: string;
    parent: string;
    list: () => Promise<McpResponse>;
    write: (filePath: string, content: string) => Promise<McpResponse>;
    revoke: () => boolean;
    replace: () => boolean;
  }) => Promise<void>,
) {
  const cli = createCliRunnerPrepareFixture(prepareCliRunContext);
  const parent = cli.session.dir;
  const root = path.join(parent, "workshop");
  const previousConfig = getRuntimeConfigSnapshot();
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: parent }, entries: { main: { default: true } } },
    plugins: { enabled: false },
    tools: { profile: "full", fs: { workspaceOnly: false } },
  };
  const admission = prepareSystemAgentRunAdmission(config, "rooted-mcp-run", "main", "rooted-test");
  const requests: Promise<McpResponse>[] = [];
  const controller = new AbortController();
  let prepared: PreparedCliRunContext | undefined;
  await runQaGatewayFixture(
    async () => {
      setRuntimeConfigSnapshot(config);
      await ensureMcpLoopbackServer();
      const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "isolated MCP runtime");
      prepared = await cli.prepare({
        config,
        runId: "rooted-mcp-run",
        sessionKey: "agent:main:main",
        preparedRunAdmission: admission,
        rootedExecution: { root },
        skillsSnapshot: { prompt: "", skills: [] },
        cliToolAvailability: { native: [], openClaw: ["read", "write"] },
        trigger: "cron",
        timeoutMs: 60_000,
      });
      const token = expectDefined(prepared.preparedBackend.env?.OPENCLAW_MCP_TOKEN, "CLI grant");
      const capture = {
        token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey: "rooted-capture",
      };
      expectDefined(prepared.preparedBackend.mcpClientGrantCapture, "CLI capture").activate(
        capture.captureKey,
      );
      const request = (method: string, params?: Record<string, unknown>) => {
        const response = (async () => {
          const result = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-openclaw-cli-capture-key": capture.captureKey,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          expect(result.status).toBe(200);
          return (await result.json()) as McpResponse;
        })();
        requests.push(response);
        void response.catch(() => {});
        return response;
      };
      await run({
        root,
        parent,
        list: () => request("tools/list"),
        write: (filePath, content) =>
          request("tools/call", { name: "write", arguments: { path: filePath, content } }),
        revoke: () => revokeMcpLoopbackClientGrant(token),
        replace: () => activateMcpLoopbackClientGrantCapture(capture) !== false,
      });
    },
    () => controller.abort(),
    () => Promise.allSettled(requests),
    () => closeMcpLoopbackServer(),
    () => prepared?.preparedBackend.cleanup?.(),
    () => admission.close(),
    () =>
      previousConfig ? setRuntimeConfigSnapshot(previousConfig) : clearRuntimeConfigSnapshot(),
    () => closeOpenClawStateDatabaseForTest(),
    () => cli.cleanup(),
  );
}

describe("rooted CLI grants through MCP HTTP dispatch", () => {
  it("writes the review report and rejects out-of-root effects through the prepared grant", async () => {
    await withRootedCli(async ({ root, parent, list, write }) => {
      expect((await list()).result.tools?.map((tool) => tool.name).toSorted()).toEqual([
        "read",
        "write",
      ]);
      expect((await write("report.md", "Workshop review complete")).result.isError).toBe(false);
      await expect(fs.readFile(path.join(root, "report.md"), "utf8")).resolves.toBe(
        "Workshop review complete",
      );
      const outside = path.join(parent, "outside.md");
      await fs.writeFile(outside, "outside unchanged");
      expect((await write(outside, "must not write")).result.isError).toBe(true);
      await expect(fs.readFile(outside, "utf8")).resolves.toBe("outside unchanged");
    });
  });

  it.each(["revoke", "replace"] as const)(
    "prevents a pending file write when the grant is changed by %s",
    async (change) => {
      await withRootedCli(async (fixture) => {
        const report = path.join(fixture.root, "report.md");
        await fs.writeFile(report, "original report");
        await fixture.list();
        const entered = createDeferred();
        const release = createDeferred();
        const openRoot = fsSafe.root;
        vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
          const handle = await openRoot(...args);
          if (args[0] === fixture.root) {
            entered.resolve();
            await release.promise;
          }
          return handle;
        });
        const response = fixture.write("report.md", "stale write");
        try {
          await Promise.race([
            entered.promise,
            response.then(() => {
              throw new Error("write completed before filesystem preparation was paused");
            }),
          ]);
          expect(fixture[change]()).toBe(true);
        } finally {
          release.resolve();
        }
        const result = await response;
        expect(result.result.isError).toBe(true);
        expect(JSON.stringify(result.result.content)).toContain("authority is no longer active");
        await expect(fs.readFile(report, "utf8")).resolves.toBe("original report");
        if (change === "replace") {
          expect((await fixture.write("report.md", "fresh write")).result.isError).toBe(false);
          await expect(fs.readFile(report, "utf8")).resolves.toBe("fresh write");
        }
      });
    },
  );
});
