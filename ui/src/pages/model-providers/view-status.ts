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

export function hasVerifiedProvider(card: ModelProviderCard): boolean {
  return classifyModelProviderCard(card).verified;
}

export function renderProviderStatus(card: ModelProviderCard) {
  switch (classifyModelProviderCard(card).status) {
    case "auth":
      return renderAuthStatus(card);
    case "denied":
      return renderSettingsStatus({ kind: "danger", label: t("modelProviders.status.denied") });
    case "unavailable":
      return renderSettingsStatus({ kind: "warn", label: t("common.failed") });
    case "ready":
      return renderSettingsStatus({ kind: "ok", label: t("modelProviders.status.ready") });
    case "not-set-up":
      return renderSettingsStatus({ kind: "muted", label: t("modelProviders.status.notSetUp") });
    case "available":
      return renderSettingsStatus({ kind: "muted", label: t("modelProviders.status.ok") });
    case "configured":
      return renderSettingsStatus({ kind: "muted", label: t("modelProviders.status.configured") });
  }
  return nothing;
}
