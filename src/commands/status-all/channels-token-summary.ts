// Summarizes channel token/account credential fields for `openclaw status --all`.
// The display path is intentionally secret-safe unless the caller explicitly requests disclosure.

import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { sha256HexPrefix } from "../../logging/redact-identifier.js";

export type ChannelAccountTokenSummaryRow = {
  account: unknown;
  enabled: boolean;
  snapshot: ChannelAccountSnapshot;
};

/** Collapses credential sources into a stable count label such as `env×2+file`. */
function summarizeSources(sources: Array<string | undefined>): {
  label: string;
  parts: string[];
} {
  const counts = new Map<string, number>();
  for (const s of sources) {
    const key = s?.trim() ? s.trim() : "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key}${n > 1 ? `×${n}` : ""}`);
  const label = parts.length > 0 ? parts.join("+") : "unknown";
  return { label, parts };
}

function formatTokenHint(token: string, opts: { showSecrets: boolean }): string {
  const t = token.trim();
  if (!t) {
    return "empty";
  }
  if (!opts.showSecrets) {
    // Show a stable fingerprint and length so operators can compare tokens without leaking them.
    return `sha256:${sha256HexPrefix(t, 8)} · len ${t.length}`;
  }
  const head = sliceUtf16Safe(t, 0, 4);
  const tail = sliceUtf16Safe(t, -4);
  if (t.length <= 10) {
    return `${t} · len ${t.length}`;
  }
  return `${head}…${tail} · len ${t.length}`;
}

/** Returns the credential status sentence for enabled channel accounts, if the plugin exposes token fields. */
export function summarizeTokenConfig(params: {
  accounts: ChannelAccountTokenSummaryRow[];
  showSecrets: boolean;
}): { state: "ok" | "setup" | "warn" | null; detail: string | null } {
  const enabled = params.accounts.filter((a) => a.enabled);
  if (enabled.length === 0) {
    return { state: null, detail: null };
  }

  const accountRecs = enabled.map((a) => asRecord(a.account));
  // Token field names are plugin-owned; infer the credential mode from the fields the plugin exposes.
  const hasBotTokenField = accountRecs.some((r) => "botToken" in r);
  const hasAppTokenField = accountRecs.some((r) => "appToken" in r);
  const hasSigningSecretField = accountRecs.some(
    (r) => "signingSecret" in r || "signingSecretSource" in r || "signingSecretStatus" in r,
  );
  const hasTokenField = accountRecs.some((r) => "token" in r);

  if (!hasBotTokenField && !hasAppTokenField && !hasSigningSecretField && !hasTokenField) {
    return { state: null, detail: null };
  }

  const accountIsHttpMode = (rec: Record<string, unknown>) =>
    typeof rec.mode === "string" && rec.mode.trim() === "http";
  const hasCredentialAvailable = (
    rec: Record<string, unknown>,
    valueKey: string,
    statusKey: string,
  ) => {
    const value = rec[valueKey];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
    return rec[statusKey] === "available";
  };

  if (
    hasBotTokenField &&
    hasSigningSecretField &&
    enabled.every((a) => accountIsHttpMode(asRecord(a.account)))
  ) {
    // Slack/Mattermost-style HTTP mode needs both bot token and signing secret to receive events.
    const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      return (
        hasCredentialAvailable(rec, "botToken", "botTokenStatus") &&
        hasCredentialAvailable(rec, "signingSecret", "signingSecretStatus")
      );
    });
    const partial = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const hasBot = hasCredentialAvailable(rec, "botToken", "botTokenStatus");
      const hasSigning = hasCredentialAvailable(rec, "signingSecret", "signingSecretStatus");
      return (hasBot && !hasSigning) || (!hasBot && hasSigning);
    });

    if (unavailable.length > 0) {
      return {
        state: "warn",
        detail: `configured http credentials unavailable in this command path · accounts ${unavailable.length}`,
      };
    }

    if (partial.length > 0) {
      return {
        state: "warn",
        detail: `partial credentials (need bot+signing) · accounts ${partial.length}`,
      };
    }

    if (ready.length === 0) {
      return { state: "setup", detail: "no credentials (need bot+signing)" };
    }

    const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
    const signingSources = summarizeSources(
      ready.map((a) => a.snapshot.signingSecretSource ?? "none"),
    );
    const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
    const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
    const signingSecret = typeof sample.signingSecret === "string" ? sample.signingSecret : "";
    const botHint = botToken.trim()
      ? formatTokenHint(botToken, { showSecrets: params.showSecrets })
      : "";
    const signingHint = signingSecret.trim()
      ? formatTokenHint(signingSecret, { showSecrets: params.showSecrets })
      : "";
    const hint =
      botHint || signingHint ? ` (bot ${botHint || "?"}, signing ${signingHint || "?"})` : "";
    return {
      state: "ok",
      detail: `credentials ok (bot ${botSources.label}, signing ${signingSources.label})${hint} · accounts ${ready.length}/${enabled.length || 1}`,
    };
  }

  if (hasBotTokenField && hasAppTokenField) {
    // Socket-mode style plugins require both halves; a single present token is still unusable.
    const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = normalizeOptionalString(rec.botToken) ?? "";
      const app = normalizeOptionalString(rec.appToken) ?? "";
      return Boolean(bot) && Boolean(app);
    });
    const partial = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = normalizeOptionalString(rec.botToken) ?? "";
      const app = normalizeOptionalString(rec.appToken) ?? "";
      const hasBot = Boolean(bot);
      const hasApp = Boolean(app);
      return (hasBot && !hasApp) || (!hasBot && hasApp);
    });

    if (partial.length > 0) {
      return {
        state: "warn",
        detail: `partial tokens (need bot+app) · accounts ${partial.length}`,
      };
    }

    if (unavailable.length > 0) {
      return {
        state: "warn",
        detail: `configured tokens unavailable in this command path · accounts ${unavailable.length}`,
      };
    }

    if (ready.length === 0) {
      return { state: "setup", detail: "no tokens (need bot+app)" };
    }

    const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
    const appSources = summarizeSources(ready.map((a) => a.snapshot.appTokenSource ?? "none"));

    const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
    const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
    const appToken = typeof sample.appToken === "string" ? sample.appToken : "";
    const botHint = botToken.trim()
      ? formatTokenHint(botToken, { showSecrets: params.showSecrets })
      : "";
    const appHint = appToken.trim()
      ? formatTokenHint(appToken, { showSecrets: params.showSecrets })
      : "";

    const hint = botHint || appHint ? ` (bot ${botHint || "?"}, app ${appHint || "?"})` : "";
    return {
      state: "ok",
      detail: `tokens ok (bot ${botSources.label}, app ${appSources.label})${hint} · accounts ${ready.length}/${enabled.length || 1}`,
    };
  }

  if (hasBotTokenField) {
    const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = normalizeOptionalString(rec.botToken) ?? "";
      return Boolean(bot);
    });

    if (unavailable.length > 0) {
      return {
        state: "warn",
        detail: `configured bot token unavailable in this command path · accounts ${unavailable.length}`,
      };
    }

    if (ready.length === 0) {
      return { state: "setup", detail: "no bot token" };
    }

    const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
    const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
    const botHint = botToken.trim()
      ? formatTokenHint(botToken, { showSecrets: params.showSecrets })
      : "";
    const hint = botHint ? ` (${botHint})` : "";

    return {
      state: "ok",
      detail: `bot token config${hint} · accounts ${ready.length}/${enabled.length || 1}`,
    };
  }

  const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
  const ready = enabled.filter((a) => {
    const rec = asRecord(a.account);
    return Boolean(normalizeOptionalString(rec.token));
  });
  if (unavailable.length > 0) {
    return {
      state: "warn",
      detail: `configured token unavailable in this command path · accounts ${unavailable.length}`,
    };
  }
  if (ready.length === 0) {
    return { state: "setup", detail: "no token" };
  }

  const sources = summarizeSources(ready.map((a) => a.snapshot.tokenSource));
  const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
  const token = typeof sample.token === "string" ? sample.token : "";
  const hint = token.trim()
    ? ` (${formatTokenHint(token, { showSecrets: params.showSecrets })})`
    : "";
  return {
    state: "ok",
    detail: `token ${sources.label}${hint} · accounts ${ready.length}/${enabled.length || 1}`,
  };
}
