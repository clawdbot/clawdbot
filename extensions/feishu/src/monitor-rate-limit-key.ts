function normalizeFeishuWebhookRateLimitClient(clientIp: string | undefined): string {
  if (!clientIp) {
    return "unknown";
  }
  if (clientIp === "::1" || clientIp.startsWith("127.")) {
    return "loopback";
  }
  return clientIp;
}

export function buildFeishuWebhookRateLimitKey(params: {
  accountId: string;
  path: string;
  clientIp?: string;
}): string {
  return `${params.accountId}:${params.path}:${normalizeFeishuWebhookRateLimitClient(
    params.clientIp,
  )}`;
}
