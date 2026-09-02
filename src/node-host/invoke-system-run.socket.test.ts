import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testing as approvalsTesting } from "../infra/exec-approvals-store.test-support.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import { requestExecHostViaSocket, type ExecHostRequest } from "../infra/exec-host.js";
import { withJsonlSocketPeer } from "../infra/jsonl-socket.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";

describe.runIf(process.platform !== "win32")("required companion invocation boundary", () => {
  it.each(["not-submitted", "outcome-unknown", "cancelled"] as const)(
    "reports %s without local fallback or false denial events",
    async (outcome) => {
      const controller = new AbortController();
      const token = "invoke-socket-test-token";
      const command = [
        "/bin/sh",
        "-c",
        'printf "START\\nCOMPLETE\\n" >> "$1"',
        "exec-proof",
        "executions",
      ];
      const order: string[] = [];
      await withJsonlSocketPeer(
        async (socket, wire) => {
          if (outcome === "cancelled") {
            controller.abort();
            return;
          }
          const envelope = JSON.parse(wire) as {
            nonce: string;
            ts: number;
            hmac: string;
            requestJson: string;
          };
          expect(envelope.hmac).toBe(
            crypto
              .createHmac("sha256", token)
              .update(`${envelope.nonce}:${envelope.ts}:${envelope.requestJson}`)
              .digest("hex"),
          );
          const request = JSON.parse(envelope.requestJson) as ExecHostRequest;
          expect(request.command).toEqual(command);
          const [executable, ...args] = request.command;
          assert.ok(executable, "Exec peer received an empty command");
          assert.ok(request.cwd, "Exec peer received no working directory");
          const child = spawn(executable, args, {
            cwd: request.cwd,
            env: { HOME: request.cwd, PATH: "/usr/bin:/bin" },
            stdio: "ignore",
          });
          expect(await once(child, "close")).toEqual([0, null]);
          expect(await fs.readFile(path.join(request.cwd, "executions"), "utf8")).toBe(
            "START\nCOMPLETE\n",
          );
          order.push("child-completed");
          socket.end();
          order.push("response-dropped");
        },
        async ({ dir, socketPath, requests }) => {
          await withEnvAsync(
            { OPENCLAW_HOME: dir, OPENCLAW_STATE_DIR: path.join(dir, "state") },
            async () => {
              closeOpenClawStateDatabaseForTest();
              approvalsTesting.reset();
              try {
                saveExecApprovals({
                  version: 1,
                  socket: { path: socketPath, token },
                  defaults: { security: "full", ask: "off", autoAllowSkills: false },
                  agents: {},
                });
                const runCommand = vi
                  .fn<Parameters<typeof handleSystemRunInvoke>[0]["runCommand"]>()
                  .mockResolvedValue({
                    success: true,
                    stdout: "unexpected local replay",
                    stderr: "",
                    exitCode: 0,
                    timedOut: false,
                    truncated: false,
                  });
                const sendInvokeResult = vi.fn();
                const sendNodeEvent = vi.fn();
                const sendExecFinishedEvent = vi.fn();
                await handleSystemRunInvoke({
                  client: {
                    request: async () => {
                      throw new Error("Unexpected Gateway request");
                    },
                  },
                  params: { command, cwd: dir, sessionKey: "agent:main:proof" },
                  skillBins: { current: async () => [] },
                  signal: controller.signal,
                  resolveExecSecurity: () => "full",
                  resolveExecAsk: () => "off",
                  isCmdExeInvocation: () => false,
                  sanitizeEnv: () => undefined,
                  getRuntimeConfig: () => ({}),
                  runCommand,
                  runViaMacAppExecHost: async ({ approvals, request, signal }) => {
                    const response = await requestExecHostViaSocket({
                      socketPath:
                        outcome === "not-submitted"
                          ? path.join(dir, "missing.sock")
                          : approvals.socketPath,
                      token: approvals.token,
                      request,
                      signal,
                      timeoutMs: outcome === "outcome-unknown" ? 2_000 : 1_000,
                    });
                    expect(response).toEqual({ ok: false, error: outcome });
                    order.push(`client-${outcome}`);
                    return response;
                  },
                  sendInvokeResult,
                  sendNodeEvent,
                  sendExecFinishedEvent,
                  buildExecEventPayload: (payload) => payload,
                });
                expect(requests).toHaveLength(outcome === "not-submitted" ? 0 : 1);
                expect(runCommand).not.toHaveBeenCalled();
                expect(sendExecFinishedEvent).not.toHaveBeenCalled();
                expect(sendNodeEvent).not.toHaveBeenCalled();
                if (outcome === "cancelled") {
                  expect(sendInvokeResult).not.toHaveBeenCalled();
                } else {
                  expect(sendInvokeResult).toHaveBeenCalledExactlyOnceWith({
                    ok: false,
                    error: {
                      code: outcome === "not-submitted" ? "SYSTEM_RUN_NOT_STARTED" : "UNAVAILABLE",
                      message: expect.any(String),
                    },
                  });
                }
                if (outcome === "outcome-unknown") {
                  expect(order).toEqual([
                    "child-completed",
                    "response-dropped",
                    "client-outcome-unknown",
                  ]);
                  expect(await fs.readFile(path.join(dir, "executions"), "utf8")).toBe(
                    "START\nCOMPLETE\n",
                  );
                }
              } finally {
                controller.abort();
                approvalsTesting.reset();
                closeOpenClawStateDatabaseForTest();
              }
            },
          );
        },
      );
    },
  );
});
