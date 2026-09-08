import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
// Classifies a Gateway connect failure into what the login gate should say and where the fix lives.
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { t } from "../i18n/index.ts";
import {
  redactLoginFailureError,
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "../lib/connection-hints.ts";
import { formatGatewayHost } from "../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../lib/gateway-secret-shape.ts";

function isPasswordModeErrorCode(code: string | null): boolean {
  return (
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED
  );
}

type LoginFailureKind =
  | "auth-required"
  | "auth-failed"
  | "trusted-proxy"
  | "auth-rate-limited"
  | "profile-unavailable"
  | "verified-user-required"
  | "pairing-required"
  | "insecure-context"
  | "origin-not-allowed"
  | "build-mismatch"
  | "protocol-mismatch"
  | "network";

/**
 * Where the fix lives decides the layout. "form": the operator fixes it in this
 * form (URL or credential), so the form leads. "status": the fix happens on the
 * Gateway host or in the browser, so the explanation leads and the form folds
 * away into a one-line connection summary.
 */
type LoginFailurePlacement = "form" | "status";

/** Pending is an expected wait, not a fault; the palette follows that distinction. */
export type LoginFailureTone = "pending" | "warn" | "danger";

type LoginFormField = "url" | "credential";

export type LoginFailureStep = {
  text: string;
  commands: string[];
};

type LoginFailureStepDefinition =
  | string
  | {
      key: string;
      commands: string[];
    };

export type LoginFailureFeedback = {
  kind: LoginFailureKind;
  placement: LoginFailurePlacement;
  tone: LoginFailureTone;
  field?: LoginFormField;
  title: string;
  summary: string;
  /** One command that resolves the failure on its own, shown as the hero action. */
  primaryCommand?: string;
  refreshAction?: { label: string };
  steps: LoginFailureStep[];
  docsHref: string;
  rawError: string;
};

export type LoginFailureFeedbackParams = Parameters<typeof resolveAuthHintKind>[0] & {
  gatewayUrl?: string;
  secret?: string;
  reconnectPending?: boolean;
};

function buildFeedback(params: {
  kind: LoginFailureKind;
  placement?: LoginFailurePlacement;
  tone?: LoginFailureTone;
  field?: LoginFormField;
  rawError: string;
  docsHref?: string;
  titleKey: string;
  summaryKey?: string;
  primaryCommand?: string;
  stepKeys: LoginFailureStepDefinition[];
  stepParams?: Record<string, string>;
  refreshAction?: { label: string };
}): LoginFailureFeedback {
  const docsHref = params.docsHref ?? "https://docs.openclaw.ai/web/dashboard";
  const rawError = redactLoginFailureError(params.rawError);
  return {
    kind: params.kind,
    placement: params.placement ?? "status",
    tone: params.tone ?? "danger",
    field: params.field,
    title: t(params.titleKey, params.stepParams),
    summary: params.summaryKey ? t(params.summaryKey, params.stepParams) : rawError,
    primaryCommand: params.primaryCommand,
    refreshAction: params.refreshAction,
    steps: params.stepKeys.map((step) =>
      typeof step === "string"
        ? { text: t(step, params.stepParams), commands: [] }
        : { text: t(step.key, params.stepParams), commands: step.commands },
    ),
    docsHref,
    rawError,
  };
}

export function resolveLoginFailureFeedback(
  params: LoginFailureFeedbackParams,
): LoginFailureFeedback | null {
  if (params.connected || !params.lastError) {
    return null;
  }

  const rawError = params.lastError;
  const lastErrorCode = params.lastErrorCode ?? null;
  const lower = normalizeLowercaseStringOrEmpty(rawError);
  const host = formatGatewayHost(params.gatewayUrl);

  if (lastErrorCode === ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE) {
    return buildFeedback({
      kind: "profile-unavailable",
      tone: "pending",
      rawError,
      titleKey: "login.failure.profileUnavailable.title",
      stepKeys: [
        "login.failure.profileUnavailable.stepRetry",
        "login.failure.profileUnavailable.stepAdmin",
      ],
      docsHref: "https://docs.openclaw.ai/concepts/user-model#gateway-profile-and-github-credit",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED) {
    return buildFeedback({
      kind: "verified-user-required",
      rawError,
      titleKey: "login.failure.verifiedUserRequired.title",
      summaryKey: "login.failure.verifiedUserRequired.summary",
      stepKeys: [
        "login.failure.verifiedUserRequired.stepIdentity",
        "login.failure.verifiedUserRequired.stepSharedSecret",
      ],
      docsHref: "https://docs.openclaw.ai/gateway/operator-scopes",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH) {
    return buildFeedback({
      kind: "build-mismatch",
      tone: "pending",
      rawError,
      titleKey: "chat.sidebar.serverUpdatedTitle",
      summaryKey: "chat.sidebar.serverUpdatedRefresh",
      refreshAction: { label: t("login.failure.protocol.refresh") },
      stepKeys: [],
      docsHref: "https://docs.openclaw.ai/web/control-ui",
    });
  }

  const pairing = resolvePairingHint(false, rawError, lastErrorCode);
  if (pairing) {
    return buildFeedback({
      kind: "pairing-required",
      tone: "pending",
      rawError,
      docsHref: "https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection",
      titleKey:
        pairing.kind === "scope-upgrade-pending"
          ? "login.failure.pairing.scopeTitle"
          : pairing.kind === "role-upgrade-pending"
            ? "login.failure.pairing.roleTitle"
            : pairing.kind === "metadata-upgrade-pending"
              ? "login.failure.pairing.metadataTitle"
              : "login.failure.pairing.title",
      summaryKey:
        pairing.kind === "pairing-required"
          ? "login.failure.pairing.summary"
          : "login.failure.pairing.upgradeSummary",
      // `approve --latest` only previews the newest pending request and prints the
      // exact approve command; without a request id the steps say to run that too.
      primaryCommand: pairing.requestId
        ? `openclaw devices approve ${pairing.requestId}`
        : "openclaw devices approve --latest",
      stepKeys: [
        ...(pairing.requestId ? [] : ["login.failure.pairing.stepLatest"]),
        { key: "login.failure.pairing.stepDashboard", commands: ["openclaw dashboard"] },
        ...(params.reconnectPending ? [] : ["login.failure.pairing.stepReconnect"]),
      ],
      stepParams: { host },
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    lower.includes("too many failed authentication attempts") ||
    lower.includes("rate limit")
  ) {
    return buildFeedback({
      kind: "auth-rate-limited",
      tone: "warn",
      rawError,
      titleKey: "login.failure.rateLimited.title",
      summaryKey: "login.failure.rateLimited.summary",
      stepKeys: [
        "login.failure.rateLimited.stepStop",
        "login.failure.rateLimited.stepWait",
        "login.failure.rateLimited.stepCheckClients",
      ],
    });
  }

  if (shouldShowInsecureContextHint(false, rawError, lastErrorCode)) {
    return buildFeedback({
      kind: "insecure-context",
      rawError,
      docsHref: "https://docs.openclaw.ai/web/control-ui#insecure-http",
      titleKey: "login.failure.insecure.title",
      summaryKey: "login.failure.insecure.summary",
      stepKeys: ["login.failure.insecure.stepHttps", "login.failure.insecure.stepAvoidDisable"],
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED ||
    lower.includes("origin not allowed")
  ) {
    return buildFeedback({
      kind: "origin-not-allowed",
      rawError,
      docsHref:
        "https://docs.openclaw.ai/web/control-ui#debuggingtesting-dev-server--remote-gateway",
      titleKey: "login.failure.origin.title",
      summaryKey: "login.failure.origin.summary",
      stepKeys: [
        "login.failure.origin.stepAllowedOrigins",
        "login.failure.origin.stepFullOrigin",
        "login.failure.origin.stepRestart",
      ],
    });
  }

  if (lower.includes("protocol mismatch")) {
    return buildFeedback({
      kind: "protocol-mismatch",
      rawError,
      docsHref:
        "https://docs.openclaw.ai/web/control-ui#debuggingtesting-dev-server--remote-gateway",
      titleKey: "login.failure.protocol.title",
      summaryKey: "login.failure.protocol.summary",
      refreshAction: { label: t("login.failure.protocol.refresh") },
      stepKeys: [
        { key: "login.failure.protocol.stepDashboard", commands: ["openclaw dashboard"] },
        { key: "login.failure.protocol.stepDevUi", commands: ["pnpm ui:dev"] },
        "login.failure.protocol.stepRestart",
      ],
    });
  }

  const authHintKind = resolveAuthHintKind(params);
  const expectsPassword = isPasswordModeErrorCode(lastErrorCode);
  if (authHintKind === "trusted-proxy") {
    return buildFeedback({
      kind: "trusted-proxy",
      rawError,
      titleKey: "login.failure.trustedProxy.title",
      summaryKey: "login.failure.trustedProxy.summary",
      stepKeys: [
        "login.failure.trustedProxy.stepSignIn",
        "login.failure.trustedProxy.stepHeaders",
        "login.failure.trustedProxy.stepNoToken",
      ],
      docsHref: "https://docs.openclaw.ai/gateway/trusted-proxy-auth",
    });
  }
  if (authHintKind === "required") {
    return buildFeedback({
      kind: "auth-required",
      placement: "form",
      tone: "warn",
      field: "credential",
      rawError,
      titleKey: expectsPassword
        ? "login.failure.authRequired.passwordTitle"
        : "login.failure.authRequired.title",
      summaryKey: "login.failure.authRequired.summary",
      stepKeys: expectsPassword
        ? ["login.failure.authRequired.stepPassword", "login.failure.authRequired.stepConnect"]
        : [
            {
              key: "login.failure.authRequired.stepPaste",
              commands: ["openclaw gateway auth-token --show"],
            },
            {
              key: "login.failure.authRequired.stepGenerate",
              commands: ["openclaw doctor --generate-gateway-token"],
            },
            "login.failure.authRequired.stepConnect",
          ],
      stepParams: { host },
    });
  }
  if (authHintKind === "failed") {
    return buildFeedback({
      kind: "auth-failed",
      placement: "form",
      field: "credential",
      rawError,
      titleKey: expectsPassword
        ? "login.failure.authRequired.passwordTitle"
        : lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
          ? "login.failure.authRequired.title"
          : "login.failure.authFailed.title",
      summaryKey:
        (lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH ||
          lastErrorCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH) &&
        classifyGatewaySecret(params.secret ?? "") === "setup-code"
          ? "login.setupCodeHint"
          : "login.failure.authFailed.summary",
      stepKeys: expectsPassword
        ? ["login.failure.authRequired.stepPassword", "login.failure.authRequired.stepConnect"]
        : [
            {
              key: "login.failure.authFailed.stepDashboard",
              commands: ["openclaw dashboard --no-open", "openclaw gateway auth-token --show"],
            },
            "login.failure.authFailed.stepReplace",
          ],
      stepParams: { host },
    });
  }

  return buildFeedback({
    kind: "network",
    placement: "form",
    tone: "warn",
    field: "url",
    rawError,
    titleKey: "login.failure.network.title",
    summaryKey: "login.failure.network.summary",
    stepKeys: [
      {
        key: "login.failure.network.stepGateway",
        commands: ["openclaw status", "openclaw gateway run"],
      },
      "login.failure.network.stepUrl",
      {
        key: "login.failure.network.stepDashboard",
        commands: ["openclaw dashboard --no-open"],
      },
    ],
    stepParams: { host },
  });
}
