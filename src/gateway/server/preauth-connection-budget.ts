const DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP = 32;
const UNKNOWN_CLIENT_IP_BUDGET_KEY = "__openclaw_unknown_client_ip__";

function getMaxPreauthConnectionsPerIpFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configured =
    env.OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP ||
    (env.VITEST && env.OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP);
  if (!configured) {
    return DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
  }
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
  }
  return Math.max(1, Math.floor(parsed));
}

export type PreauthConnectionBudget = {
  acquire(clientIp: string | undefined): boolean;
  release(clientIp: string | undefined): void;
};

export function createPreauthConnectionBudget(
  limit = getMaxPreauthConnectionsPerIpFromEnv(),
): PreauthConnectionBudget {
  const counts = new Map<string, number>();
  const normalizeBudgetKey = (clientIp: string | undefined) => {
    const ip = clientIp?.trim();
    // Trusted-proxy mode can intentionally leave client IP unresolved when
    // forwarded headers are missing or invalid; keep those upgrades capped
    // under a shared fallback bucket instead of failing open.
    return ip || UNKNOWN_CLIENT_IP_BUDGET_KEY;
  };

  return {
    acquire(clientIp) {
      const ip = normalizeBudgetKey(clientIp);
      const next = (counts.get(ip) ?? 0) + 1;
      if (next > limit) {
        return false;
      }
      counts.set(ip, next);
      return true;
    },
    release(clientIp) {
      const ip = normalizeBudgetKey(clientIp);
      const current = counts.get(ip);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        counts.delete(ip);
        return;
      }
      counts.set(ip, current - 1);
    },
  };
}
