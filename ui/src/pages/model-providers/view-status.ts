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

export function hasVerifiedProvider(card: ModelProviderCard): boolean {
  return (
    card.catalogStatus === "ready" &&
    card.auth?.kind !== "expired" &&
    card.auth?.kind !== "missing" &&
    card.auth?.kind !== "expiring"
  );
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
  if (hasVerifiedProvider(card) && card.availableModelCount > 0) {
    return renderSettingsStatus({
      kind: "ok",
      label: t("modelProviders.status.ready"),
    });
  }
  return hasVerifiedProvider(card)
    ? renderSettingsStatus({
        kind: "muted",
        label: t("modelProviders.status.ok"),
      })
    : renderSettingsStatus({
        kind: "muted",
        label: t("modelProviders.status.configured"),
      });
}
