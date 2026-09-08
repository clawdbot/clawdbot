/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createTestGatewayClient } from "./gateway-client.ts";

const requests: Array<Parameters<GatewayBrowserClient["request"]>> = [
  ["sessions.list"],
  ["sessions.describe", { key: "agent:main:main" }],
  ["sessions.describe", { key: "agent:main:main" }, undefined],
  ["sessions.reclaim", { key: "agent:main:main" }, { timeoutMs: null }],
];

it.each(requests.map((args) => ({ args, arity: args.length })))(
  "preserves the exact $arity-argument Gateway request tuple",
  async ({ args }) => {
    const request = vi.fn(async () => ({ ok: true }));
    const client = createTestGatewayClient(request);
    await expect(client.request(...args)).resolves.toEqual({ ok: true });
    expect(request.mock.calls).toStrictEqual([args]);
  },
);
