// Prove authoritative Mattermost channel kinds over the real Bot API transport.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveMattermostOutboundSessionRoute } from "../session-route.js";
import { resolveMattermostOpaqueTarget } from "./target-resolution.js";

const PUBLIC_CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";
const PRIVATE_CHANNEL_ID = "bcdefghijklmnopqrstuvwxyza";

describe("Mattermost opaque channel resolution over real HTTP", () => {
  it("preserves real public and private channel identities in outbound thread routes", async () => {
    const requests: Array<{ method: string; path: string; authorization?: string }> = [];

    await withServer(
      (request, response) => {
        const path = request.url ?? "";
        requests.push({
          method: request.method ?? "",
          path,
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");

        if (path.startsWith("/api/v4/users/")) {
          response.writeHead(404);
          response.end(JSON.stringify({ message: "user not found" }));
          return;
        }

        if (path === `/api/v4/channels/${PUBLIC_CHANNEL_ID}`) {
          response.writeHead(200);
          response.end(JSON.stringify({ id: PUBLIC_CHANNEL_ID, type: "O" }));
          return;
        }

        if (path === `/api/v4/channels/${PRIVATE_CHANNEL_ID}`) {
          response.writeHead(200);
          response.end(JSON.stringify({ id: PRIVATE_CHANNEL_ID, type: "P" }));
          return;
        }

        response.writeHead(404);
        response.end(JSON.stringify({ message: "unexpected loopback path" }));
      },
      async (baseUrl) => {
        const cfg = {
          channels: {
            mattermost: {
              botToken: "mattermost-loopback-fixture",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;

        const cases = [
          { id: PUBLIC_CHANNEL_ID, kind: "channel" },
          { id: PRIVATE_CHANNEL_ID, kind: "group" },
        ] as const;

        for (const testCase of cases) {
          const resolved = await resolveMattermostOpaqueTarget({
            input: testCase.id,
            cfg,
            accountId: "default",
          });
          expect(resolved).toEqual({
            kind: testCase.kind,
            id: testCase.id,
            to: `channel:${testCase.id}`,
          });

          const route = resolveMattermostOutboundSessionRoute({
            cfg,
            agentId: "main",
            accountId: "default",
            target: `channel:${testCase.id}`,
            resolvedTarget: {
              to: `channel:${testCase.id}`,
              kind: testCase.kind,
              source: "directory",
            },
            threadId: "loopback-thread",
          });
          expect(route).toMatchObject({
            peer: { kind: testCase.kind, id: testCase.id },
            chatType: testCase.kind,
            to: `channel:${testCase.id}`,
            sessionKey: `agent:main:mattermost:${testCase.kind}:${testCase.id}:thread:loopback-thread`,
          });
        }

        expect(requests).toEqual([
          {
            method: "GET",
            path: `/api/v4/users/${PUBLIC_CHANNEL_ID}`,
            authorization: "Bearer mattermost-loopback-fixture",
          },
          {
            method: "GET",
            path: `/api/v4/channels/${PUBLIC_CHANNEL_ID}`,
            authorization: "Bearer mattermost-loopback-fixture",
          },
          {
            method: "GET",
            path: `/api/v4/users/${PRIVATE_CHANNEL_ID}`,
            authorization: "Bearer mattermost-loopback-fixture",
          },
          {
            method: "GET",
            path: `/api/v4/channels/${PRIVATE_CHANNEL_ID}`,
            authorization: "Bearer mattermost-loopback-fixture",
          },
        ]);
      },
    );
  });
});
