import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { SANDBOX_CONTAINER_POLICY_RULES } from "./metadata.js";
import {
  SUPPORTED_GATEWAY_HTTP_ENDPOINTS,
  SUPPORTED_GATEWAY_POLICY_SECTIONS,
  SUPPORTED_SANDBOX_MODES,
} from "./policy-constants.js";
import {
  policyShapeFinding,
  policyStringArrayPropertyShapeFinding,
  unsupportedPolicyKey,
} from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function sandboxPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "sandbox";
  const propertyPrefix = params.propertyPrefix ?? "sandbox";
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}`,
      `${params.policyPath} ${propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix} is an object.`,
    );
  }
  const unsupportedTopLevel = unsupportedPolicyKey(value, [
    "requireMode",
    "allowBackends",
    "containers",
    "browser",
  ]);
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported sandbox posture rule.`,
    );
  }
  const modeFinding = policyStringArrayPropertyShapeFinding(value.requireMode, {
    allowed: SUPPORTED_SANDBOX_MODES,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.requireMode`,
    target: `${targetPrefix}/requireMode`,
    valueName: "sandbox mode",
  });
  if (modeFinding !== undefined) {
    return modeFinding;
  }
  const backendFinding = policyStringArrayPropertyShapeFinding(value.allowBackends, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.allowBackends`,
    target: `${targetPrefix}/allowBackends`,
    valueName: "sandbox backend id",
  });
  if (backendFinding !== undefined) {
    return backendFinding;
  }
  for (const section of ["containers", "browser"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }
  const containers = isRecord(value.containers) ? value.containers : {};
  const unsupportedContainerKey = unsupportedPolicyKey(
    containers,
    SANDBOX_CONTAINER_POLICY_RULES.map((rule) => rule.key),
  );
  if (unsupportedContainerKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/containers/${ocPathSegment(unsupportedContainerKey)}`,
      `${params.policyPath} ${propertyPrefix}.containers.${unsupportedContainerKey} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.containers.${unsupportedContainerKey} or use a supported sandbox container posture rule.`,
    );
  }
  for (const { key } of SANDBOX_CONTAINER_POLICY_RULES) {
    if (containers[key] !== undefined && typeof containers[key] !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/containers/${key}`,
        `${params.policyPath} ${propertyPrefix}.containers.${key} must be a boolean.`,
        `Set ${propertyPrefix}.containers.${key} to true or false.`,
      );
    }
  }
  const browser = isRecord(value.browser) ? value.browser : {};
  const unsupportedBrowserKey = unsupportedPolicyKey(browser, ["requireCdpSourceRange"]);
  if (unsupportedBrowserKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/browser/${ocPathSegment(unsupportedBrowserKey)}`,
      `${params.policyPath} ${propertyPrefix}.browser.${unsupportedBrowserKey} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.browser.${unsupportedBrowserKey} or use a supported sandbox browser posture rule.`,
    );
  }
  if (
    browser.requireCdpSourceRange !== undefined &&
    typeof browser.requireCdpSourceRange !== "boolean"
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/browser/requireCdpSourceRange`,
      `${params.policyPath} ${propertyPrefix}.browser.requireCdpSourceRange must be a boolean.`,
      `Set ${propertyPrefix}.browser.requireCdpSourceRange to true or false.`,
    );
  }
  return undefined;
}

export function gatewayPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway`,
      `${params.policyPath} gateway must be an object.`,
      `Fix ${params.policyPath} so gateway is an object.`,
    );
  }

  for (const section of ["exposure", "auth", "controlUi", "remote", "http", "nodes"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/${section}`,
        `${params.policyPath} gateway.${section} must be an object.`,
        `Fix ${params.policyPath} so gateway.${section} is an object.`,
      );
    }
  }
  const unsupportedGatewayKey = unsupportedPolicyKey(value, SUPPORTED_GATEWAY_POLICY_SECTIONS);
  if (unsupportedGatewayKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/${ocPathSegment(unsupportedGatewayKey)}`,
      `${params.policyPath} gateway.${unsupportedGatewayKey} is not supported in Gateway policy.`,
      `Remove gateway.${unsupportedGatewayKey} or use a supported Gateway policy section.`,
    );
  }

  const exposure = isRecord(value.exposure) ? value.exposure : {};
  const auth = isRecord(value.auth) ? value.auth : {};
  const controlUi = isRecord(value.controlUi) ? value.controlUi : {};
  const remote = isRecord(value.remote) ? value.remote : {};
  const http = isRecord(value.http) ? value.http : {};
  const nodes = isRecord(value.nodes) ? value.nodes : {};
  for (const [section, sectionValue, allowedKeys] of [
    ["exposure", exposure, ["allowNonLoopbackBind", "allowTailscaleFunnel"]],
    ["auth", auth, ["requireAuth", "requireExplicitRateLimit"]],
    ["controlUi", controlUi, ["allowInsecure"]],
    ["remote", remote, ["allow"]],
    ["http", http, ["denyEndpoints", "requireUrlAllowlists"]],
    ["nodes", nodes, ["denyCommands"]],
  ] as const) {
    const unsupportedKey = unsupportedPolicyKey(sectionValue, allowedKeys);
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/${section}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} gateway.${section}.${unsupportedKey} is not supported in Gateway policy.`,
        `Remove gateway.${section}.${unsupportedKey} or use a supported Gateway policy rule.`,
      );
    }
  }
  const booleanRules = [
    [
      "gateway/exposure/allowNonLoopbackBind",
      "gateway.exposure.allowNonLoopbackBind",
      exposure.allowNonLoopbackBind,
    ],
    [
      "gateway/exposure/allowTailscaleFunnel",
      "gateway.exposure.allowTailscaleFunnel",
      exposure.allowTailscaleFunnel,
    ],
    ["gateway/auth/requireAuth", "gateway.auth.requireAuth", auth.requireAuth],
    [
      "gateway/auth/requireExplicitRateLimit",
      "gateway.auth.requireExplicitRateLimit",
      auth.requireExplicitRateLimit,
    ],
    ["gateway/controlUi/allowInsecure", "gateway.controlUi.allowInsecure", controlUi.allowInsecure],
    ["gateway/remote/allow", "gateway.remote.allow", remote.allow],
    [
      "gateway/http/requireUrlAllowlists",
      "gateway.http.requireUrlAllowlists",
      http.requireUrlAllowlists,
    ],
  ] as const;
  for (const [target, property, ruleValue] of booleanRules) {
    if (ruleValue !== undefined && typeof ruleValue !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${target}`,
        `${params.policyPath} ${property} must be a boolean.`,
        `Fix ${params.policyPath} so ${property} is true or false.`,
      );
    }
  }

  const denyEndpoints = http.denyEndpoints;
  if (denyEndpoints !== undefined && !Array.isArray(denyEndpoints)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/http/denyEndpoints`,
      `${params.policyPath} gateway.http.denyEndpoints must be an array.`,
      'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.',
    );
  }
  if (Array.isArray(denyEndpoints)) {
    const invalidIndex = denyEndpoints.findIndex(
      (entry) =>
        typeof entry !== "string" ||
        !SUPPORTED_GATEWAY_HTTP_ENDPOINTS.includes(
          entry.trim() as (typeof SUPPORTED_GATEWAY_HTTP_ENDPOINTS)[number],
        ),
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/http/denyEndpoints/#${invalidIndex}`,
        `${params.policyPath} gateway.http.denyEndpoints[${invalidIndex}] must be a supported endpoint id.`,
        `Use supported endpoint ids: ${SUPPORTED_GATEWAY_HTTP_ENDPOINTS.join(", ")}.`,
      );
    }
  }
  const denyCommands = nodes.denyCommands;
  if (denyCommands !== undefined && !Array.isArray(denyCommands)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/nodes/denyCommands`,
      `${params.policyPath} gateway.nodes.denyCommands must be an array.`,
      'Use an array of node command ids such as ["system.run"] or remove gateway.nodes.denyCommands.',
    );
  }
  if (Array.isArray(denyCommands)) {
    const invalidIndex = denyCommands.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/nodes/denyCommands/#${invalidIndex}`,
        `${params.policyPath} gateway.nodes.denyCommands[${invalidIndex}] must be a non-empty node command id.`,
        "Use non-empty node command ids.",
      );
    }
  }
  return undefined;
}
