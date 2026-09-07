// One credential field, two modes. Shared by the login gate and Settings → Gateway
// so both surfaces pick the visible credential the same way.
import { html, type TemplateResult } from "lit";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { t } from "../i18n/index.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";

registerLoginEnglish();

export type CredentialMode = "token" | "password";

const PASSWORD_MODE_CODES = new Set<string>([
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED,
]);

export function isPasswordModeErrorCode(code: string | null | undefined): boolean {
  return Boolean(code && PASSWORD_MODE_CODES.has(code));
}

/**
 * The operator's explicit choice wins. Otherwise a password-mode rejection
 * outranks a saved token (the Gateway just said which credential it wants and
 * the stale token is what got rejected), then whichever value exists.
 */
export function resolveCredentialMode(
  state: { token: string; password: string; lastErrorCode?: string | null },
  override: CredentialMode | null,
): CredentialMode {
  if (override) {
    return override;
  }
  if (isPasswordModeErrorCode(state.lastErrorCode)) {
    return "password";
  }
  if (state.token.trim()) {
    return "token";
  }
  return state.password.trim() ? "password" : "token";
}

const SWITCH_CLASSES = {
  login: { group: "login-gate__segmented", button: "", active: "" },
  settings: {
    group: "settings-segmented",
    button: "settings-segmented__btn",
    active: "settings-segmented__btn--active",
  },
} as const;

export function renderCredentialModeSwitch(params: {
  mode: CredentialMode;
  onChange: (mode: CredentialMode) => void;
  variant: keyof typeof SWITCH_CLASSES;
}): TemplateResult {
  const classes = SWITCH_CLASSES[params.variant];
  const option = (mode: CredentialMode, label: string) => {
    const active = params.mode === mode;
    const className = [classes.button, active ? classes.active : ""].filter(Boolean).join(" ");
    return html`
      <button
        type="button"
        class=${className}
        role="radio"
        aria-checked=${active}
        @click=${() => params.onChange(mode)}
      >
        ${label}
      </button>
    `;
  };
  return html`
    <div class=${classes.group} role="radiogroup" aria-label=${t("login.credentialType")}>
      ${option("token", t("login.modeToken"))} ${option("password", t("login.modePassword"))}
    </div>
  `;
}
