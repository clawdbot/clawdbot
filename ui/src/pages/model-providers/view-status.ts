import { html, nothing } from "lit";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { ModelProviderAuthKind, ModelProviderCard } from "./data.ts";

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

function hasProviderCredentials(card: ModelProviderCard): boolean {
  return card.hasConfigApiKey || Boolean(card.apiKey) || card.profiles.length > 0;
}

export function hasValidProviderSignIn(card: ModelProviderCard): boolean {
  const catalogUnavailable =
    card.catalogStatus === "auth-rejected" || card.catalogStatus === "unavailable";
  return card.auth?.kind === "ok" && !catalogUnavailable;
}

export function renderProviderStatus(card: ModelProviderCard) {
  if (
    card.auth?.kind === "expired" ||
    card.auth?.kind === "missing" ||
    card.auth?.kind === "expiring"
  ) {
    return renderAuthStatus(card);
  }
  if (card.catalogStatus === "auth-rejected") {
    return renderSettingsStatus({ kind: "danger", label: t("modelProviders.status.denied") });
  }
  if (card.catalogStatus === "unavailable") {
    return renderSettingsStatus({
      kind: "warn",
      label: t("common.failed"),
    });
  }
  if (!hasProviderCredentials(card)) {
    return renderAuthStatus(card);
  }
  if (card.availableModelCount > 0 && (hasValidProviderSignIn(card) || !card.auth)) {
    return renderSettingsStatus({
      kind: "ok",
      label: t("modelProviders.status.ready"),
    });
  }
  return hasValidProviderSignIn(card)
    ? renderSettingsStatus({
        kind: "muted",
        label: t("modelProviders.status.ok"),
      })
    : renderAuthStatus(card);
}
