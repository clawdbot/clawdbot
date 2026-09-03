import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerLogsCli } from "./logs-cli.js";

afterEach(() => vi.restoreAllMocks());

async function withLogsGateway(
  options: {
    source?: "config" | "environment";
    denied?: boolean;
    failure?: "timeout" | "disconnect" | "malformed";
  },
  run: (fixture: {
    port: string;
    requests: string[];
    stdout: string[];
    stderr: string[];
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "logs-port",
      env: {
        OPENCLAW_GATEWAY_URL:
          options.source === "environment" ? "ws://remote.example:19001" : undefined,
        OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined,
      },
    },
    async (state) => {
      await state.writeConfig({
        gateway: {
          mode: options.source === "config" ? "remote" : "local",
          auth: { mode: "none" },
          ...(options.source === "config" ? { remote: { url: "ws://remote.example:19001" } } : {}),
        },
      });
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const requests: string[] = [];
      server.on("connection", (socket) => {
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const frame = parseMinimalGatewayRequestFrame(data);
          if (!frame.id || !frame.method) {
            return;
          }
          requests.push(frame.method);
          if (frame.method === "connect") {
            sendMinimalGatewayResponse(
              socket,
              frame.id,
              buildMinimalGatewayHelloOkPayload({ methods: ["logs.tail"] }),
            );
          } else if (options.failure) {
            if (options.failure === "disconnect") {
              socket.terminate();
            } else if (options.failure === "malformed") {
              sendMinimalGatewayResponse(socket, frame.id, null);
            }
          } else if (options.denied) {
            socket.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: { code: "INVALID_REQUEST", message: "logs unavailable for this client" },
              }),
            );
          } else {
            sendMinimalGatewayResponse(socket, frame.id, {
              file: "selected-gateway.log",
              cursor: 1,
              lines: ["selected local log"],
            });
          }
        });
      });
      await once(server, "listening");
      const port = String((server.address() as AddressInfo).port);
      const stdout: string[] = [];
      const stderr: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new ExitError(code);
      });
      try {
        await run({ port, requests, stdout, stderr });
      } finally {
        await closeMinimalGatewayServer(server);
      }
    },
  );
}

async function runLogs(argv: string[]) {
  await runRegisteredCli({ register: registerLogsCli, argv: ["logs", ...argv] });
}

describe("logs local port selection", () => {
  it.each(["config", "environment"] as const)(
    "tails the selected local port instead of validating the %s default URL",
    async (source) => {
      await withLogsGateway({ source }, async ({ port, requests, stdout }) => {
        await runLogs(["--port", port, "--json", "--timeout", "1500"]);
        expect(requests).toEqual(["connect", "logs.tail"]);
        expect(stdout.join("")).toContain("selected local log");
      });
    },
  );

  it.each(["text", "json"])(
    "reports the rejection reason and selected port when the RPC fails in %s mode",
    async (mode) => {
      await withLogsGateway({ denied: true }, async ({ port, requests, stderr }) => {
        const args = [
          "--port",
          port,
          "--timeout",
          "1500",
          ...(mode === "json" ? ["--json"] : ["--plain"]),
        ];
        await expect(runLogs(args)).rejects.toBeInstanceOf(ExitError);
        expect(requests).toEqual(["connect", "logs.tail"]);
        const output = stderr.join("");
        expect(output).toContain("logs unavailable for this client");
        if (mode === "json") {
          expect(JSON.parse(output)).toMatchObject({
            type: "error",
            message: "logs unavailable for this client",
            error: "logs unavailable for this client",
            details: { url: `ws://127.0.0.1:${port}` },
          });
        } else {
          expect(output).not.toContain("Gateway not reachable");
          expect(output).toContain(`Gateway target: ws://127.0.0.1:${port}`);
        }
      });
    },
  );

  it.each([
    { failure: "timeout" as const, error: /timeout|timed out/ },
    { failure: "disconnect" as const, error: /gateway closed/ },
    { failure: "malformed" as const, error: /^Unexpected logs\.tail response$/ },
  ])(
    "uses the failure reason as the JSON summary after a post-hello $failure",
    async ({ failure, error }) => {
      await withLogsGateway({ failure }, async ({ port, requests, stdout, stderr }) => {
        await expect(
          runLogs([
            "--url",
            `ws://127.0.0.1:${port}`,
            "--token",
            "fixture-token",
            "--json",
            "--timeout",
            "1500",
          ]),
        ).rejects.toBeInstanceOf(ExitError);
        expect(requests).toEqual(["connect", "logs.tail"]);
        expect(stdout.join("")).toBe("");
        expect(JSON.parse(stderr.join(""))).toMatchObject({
          type: "error",
          message: expect.stringMatching(error),
          error: expect.stringMatching(error),
          details: { url: `ws://127.0.0.1:${port}` },
        });
      });
    },
  );

  it("honors an explicit URL even with an unusable default URL", async () => {
    await withLogsGateway({ source: "config" }, async ({ port, requests, stdout }) => {
      await runLogs([
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        "fixture-token",
        "--json",
        "--timeout",
        "1500",
      ]);
      expect(requests).toEqual(["connect", "logs.tail"]);
      expect(stdout.join("")).toContain("selected local log");
    });
  });

  it.each(["config", "environment"] as const)(
    "still rejects an unsafe %s target without an override",
    async (source) => {
      await withLogsGateway({ source }, async ({ requests }) => {
        await expect(runLogs(["--json"])).rejects.toThrow(
          "uses plaintext ws:// to a non-loopback address",
        );
        expect(requests).toEqual([]);
      });
    },
  );

  it.each([
    { args: ["--port", "65536"], message: "--port must be an integer between 1 and 65535." },
    {
      args: ["--port", "19083", "--url", "ws://127.0.0.1:19083"],
      message: "Use either --url or --port, not both.",
    },
  ])("keeps target validation for $args", async ({ args, message }) => {
    await withLogsGateway({}, async ({ requests }) => {
      await expect(runLogs(args)).rejects.toThrow(message);
      expect(requests).toEqual([]);
    });
  });
});
