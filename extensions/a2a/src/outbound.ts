import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import { resolveA2aChannelAccount } from "./accounts.js";

const A2A_OUTBOUND_TIMEOUT_MS = 30_000;

const A2aOutboundResponseSchema = z.object({
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
  result: z
    .object({
      task: z
        .object({
          id: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

type A2aOutboundSendParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
};

export async function sendA2aChannelText(
  params: A2aOutboundSendParams,
): Promise<{ to: string; messageId: string }> {
  const account = resolveA2aChannelAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const peerName = params.to.replace(/^a2a:/i, "").trim();
  const peer = account.config.peers?.[peerName];
  if (!peer?.url) {
    throw new Error(`peer ${peerName} has no url configured for outbound A2A`);
  }

  const messageId = randomUUID();
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (peer.outboundToken) {
    headers.authorization = `Bearer ${peer.outboundToken}`;
  }

  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method: "SendMessage",
    params: {
      message: {
        messageId,
        role: "ROLE_USER",
        contextId: `ctx-oc-${peerName}`,
        parts: [{ text: params.text }],
      },
      configuration: { returnImmediately: true },
    },
  };
  const signal = AbortSignal.timeout(A2A_OUTBOUND_TIMEOUT_MS);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Peer URLs are operator config, but they still leave the Gateway: the shared
    // guard keeps that egress on the same SSRF policy as every other plugin call.
    const { response, release } = await fetchWithSsrFGuard({
      url: peer.url,
      timeoutMs: A2A_OUTBOUND_TIMEOUT_MS,
      signal,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(peer.url),
      auditContext: "a2a.outbound_send",
      // A redirected A2A task could be delivered to an unintended agent.
      maxRedirects: 0,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      },
    });
    try {
      if (!response.ok) {
        throw new Error(
          `outbound A2A request to peer ${peerName} failed (HTTP ${response.status})`,
        );
      }

      const parsed = A2aOutboundResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error(`peer ${peerName} returned an invalid A2A JSON-RPC response`);
      }

      if (parsed.data.error) {
        if (attempt === 0 && parsed.data.error.code === -32601) {
          // Hermes-generation A2A 0.3 peers only expose the shipped dotted method.
          request.method = "message/send";
          continue;
        }
        throw new Error(
          `outbound A2A request to peer ${peerName} failed: ${parsed.data.error.message}`,
        );
      }

      if (!parsed.data.result) {
        throw new Error(`peer ${peerName} returned an A2A response without a result`);
      }

      return { to: params.to, messageId: parsed.data.result.task?.id ?? messageId };
    } finally {
      // Each attempt owns its guard lease, including before the compatibility retry.
      await release();
    }
  }

  throw new Error(`outbound A2A request to peer ${peerName} exhausted its compatibility retry`);
}
