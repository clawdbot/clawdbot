import { html, nothing } from "lit";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import {
  classifyModelProviderCard,
  type ModelProviderAuthKind,
  type ModelProviderCard,
} from "./data.ts";

const AUTH_KIND_I18N: Record<ModelProviderAuthKind, string> = {
  ok: "modelProviders.status.ok",
  expiring: "modelProviders.status.expiring",
  expired: "modelProviders.status.expired",
  missing: "modelProviders.status.missing",
  "api-key": "modelProviders.status.apiKey",
};

const AUTH_KIND_STATUS: Record<ModelProviderAuthKind, "ok" | "warn" | "danger" | "muted"> = {
  ok: "ok",
  expiring: "warn",
  expired: "danger",
  missing: "danger",
  "api-key": "muted",
};

function renderAuthStatus(card: ModelProviderCard) {
  const auth = card.auth;
  if (!auth) {
    return nothing;
  }
  const label = t(AUTH_KIND_I18N[auth.kind]);
  const detail = auth.expiryLabel
    ? t("modelProviders.expiresIn", { time: auth.expiryLabel })
    : undefined;
  return html`
    <span title=${detail ?? label}>
      ${renderSettingsStatus({ kind: AUTH_KIND_STATUS[auth.kind], label })}
    </span>
  `;
}

const PROVIDER_STATUS_BADGES = {
  denied: { kind: "danger", label: "modelProviders.status.denied" },
  ready: { kind: "ok", label: "modelProviders.status.ready" },
  "not-set-up": { kind: "muted", label: "modelProviders.status.notSetUp" },
  available: { kind: "muted", label: "modelProviders.status.ok" },
  configured: { kind: "muted", label: "modelProviders.status.configured" },
} as const;

export function renderProviderStatus(card: ModelProviderCard) {
  const state = classifyModelProviderCard(card);
  if (state.status === "auth") {
    return renderAuthStatus(card);
  }
  if (state.status === "unavailable") {
    return html`<span title=${state.message ?? t("common.failed")}
      >${renderSettingsStatus({ kind: "warn", label: t("common.failed") })}</span
    >`;
  }
  const badge = PROVIDER_STATUS_BADGES[state.status];
  return renderSettingsStatus({ kind: badge.kind, label: t(badge.label) });
}
