// Real send owner, Slack SDK and loopback transport; media loading and the
// SSRF adapter are synthetic so no external Slack service or filesystem is used.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackWriteClient } from "./client.js";
import { sendMessageSlack } from "./send.js";

vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl: async () => ({
    buffer: Buffer.from("synthetic upload"),
    contentType: "text/plain",
    kind: "document",
    fileName: "answer.txt",
  }),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    signal?: AbortSignal;
  }) => ({
    response: await fetch(params.url, { ...params.init, signal: params.signal }),
    finalUrl: params.url,
    release: async () => {},
  }),
}));

const SLACK_TEST_CFG = { channels: { slack: { botToken: "synthetic-upload-fixture" } } };
afterEach(() => vi.unstubAllEnvs());

describe("Slack upload rate-limit recovery", () => {
  it.each(["success", "socket", "http500"] as const)(
    "preserves upload dispatch after a completion rate limit followed by %s",
    async (terminal) => {
      const events: string[] = [];
      const completions: string[] = [];
      const onDeliveryResult = vi.fn();
      const onPlatformSendDispatch = vi.fn(async () => {
        events.push("dispatch");
      });
      let apiRoot = "";
      for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
        vi.stubEnv(key, undefined);
      }
      await withServer(
        (req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          req.on("end", () => {
            if (req.url === "/api/files.getUploadURLExternal") {
              events.push("upload-url");
              res.end(
                JSON.stringify({ ok: true, upload_url: `${apiRoot}/upload`, file_id: "F001" }),
              );
            } else if (req.url === "/upload") {
              events.push("byte-upload");
              res.end("ok");
            } else if (req.url === "/api/files.completeUploadExternal") {
              completions.push(Buffer.concat(chunks).toString("utf8"));
              events.push("completion");
              if (completions.length === 1) {
                res.writeHead(429, { "retry-after": "0" });
                res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
              } else if (terminal === "socket") {
                req.socket.destroy();
              } else if (terminal === "http500") {
                res.writeHead(500);
                res.end("synthetic finalization failure");
              } else {
                res.end(JSON.stringify({ ok: true, files: [{ id: "F001" }] }));
              }
            } else {
              res.writeHead(404);
              res.end("unexpected route");
            }
          });
        },
        async (baseUrl) => {
          apiRoot = baseUrl;
          const writeClient = createSlackWriteClient("synthetic-upload-fixture", {
            slackApiUrl: `${baseUrl}/api/`,
            teamId: "TWORKSPACE",
          });
          const outcome = await sendMessageSlack("channel:C123CHAN", "caption", {
            cfg: SLACK_TEST_CFG,
            client: writeClient,
            mediaUrl: "/tmp/rate-limited-upload.png",
            onPlatformSendDispatch,
            onDeliveryResult,
          }).then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
          expect(events).toEqual([
            "upload-url",
            "byte-upload",
            "dispatch",
            "completion",
            "completion",
          ]);
          expect(completions[0]).toBe(completions[1]);
          expect(new URLSearchParams(completions[1]).get("team_id")).toBe("TWORKSPACE");
          expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
          if (terminal === "success") {
            expect(outcome.error).toBeUndefined();
            expect(outcome.result?.receipt.platformMessageIds).toEqual(["F001"]);
            expect(onDeliveryResult).toHaveBeenCalledOnce();
          } else {
            expect(outcome.result).toBeUndefined();
            expect(outcome.error).toBeInstanceOf(Error);
            expect(outcome.error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
            expect(onDeliveryResult).not.toHaveBeenCalled();
          }
        },
      );
    },
  );
});
