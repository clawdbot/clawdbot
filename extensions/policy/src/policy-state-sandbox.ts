// Policy plugin sandbox posture evidence.
import {
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { readStringArray } from "./policy-state-tool-posture.js";
import type { PolicySandboxPostureEvidence } from "./policy-state-types.js";

// Mirrors the sandbox browser config default without importing core internals into the policy plugin.
const DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK = "openclaw-sandbox-browser";

export function scanPolicySandboxPosture(
  cfg: Record<string, unknown>,
): readonly PolicySandboxPostureEvidence[] {
  const agents = isRecord(cfg.agents) ? cfg.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const defaultSandbox = isRecord(defaults.sandbox) ? defaults.sandbox : {};
  const entries: PolicySandboxPostureEvidence[] = [];
  pushSandboxPostureEvidence(entries, {
    id: "agents-defaults",
    scope: "defaults",
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    sourceBase: "oc://openclaw.config/agents/defaults/sandbox",
    inheritedSourceBase: "oc://openclaw.config/agents/defaults/sandbox",
  });

  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((agent, index) => {
    if (!isRecord(agent)) {
      return;
    }
    const agentId =
      typeof agent.id === "string" && agent.id.trim() !== "" ? agent.id.trim() : undefined;
    const sandbox = isRecord(agent.sandbox) ? agent.sandbox : {};
    pushSandboxPostureEvidence(entries, {
      id: agentId ?? `agent-${index}`,
      scope: "agent",
      agentId,
      sandbox,
      inheritedSandbox: defaultSandbox,
      sharedSandboxScope: sandboxScopeIsShared(sandbox, defaultSandbox),
      sourceBase: `oc://openclaw.config/agents/list/#${index}/sandbox`,
      inheritedSourceBase: "oc://openclaw.config/agents/defaults/sandbox",
    });
  });

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

type SandboxPostureParams = {
  readonly id: string;
  readonly scope: "defaults" | "agent";
  readonly agentId?: string;
  readonly effectiveBackend?: string;
  readonly sandbox: Record<string, unknown>;
  readonly inheritedSandbox: Record<string, unknown>;
  readonly sharedSandboxScope?: boolean;
  readonly sourceBase: string;
  readonly inheritedSourceBase: string;
};

function pushSandboxPostureEvidence(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localMode = readString(params.sandbox.mode);
  const inheritedMode = readString(params.inheritedSandbox.mode);
  pushSandboxPostureValue(entries, params, {
    suffix: "mode",
    kind: "mode",
    value: localMode ?? inheritedMode ?? "off",
    explicit: localMode !== undefined || inheritedMode !== undefined,
    inherited: localMode === undefined && inheritedMode !== undefined,
  });

  const localBackend = readString(params.sandbox.backend);
  const inheritedBackend = readString(params.inheritedSandbox.backend);
  const effectiveBackend = (localBackend ?? inheritedBackend ?? "docker").toLowerCase();
  const effectiveParams = { ...params, effectiveBackend };
  pushSandboxPostureValue(entries, params, {
    suffix: "backend",
    kind: "backend",
    value: effectiveBackend,
    explicit: localBackend !== undefined || inheritedBackend !== undefined,
    inherited: localBackend === undefined && inheritedBackend !== undefined,
  });

  if (effectiveBackend === "docker") {
    pushSandboxDockerPosture(entries, effectiveParams);
  }
  pushSandboxBrowserPosture(entries, effectiveParams);
}

function pushSandboxDockerPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localDocker =
    !params.sharedSandboxScope && isRecord(params.sandbox.docker) ? params.sandbox.docker : {};
  const inheritedDocker = isRecord(params.inheritedSandbox.docker)
    ? params.inheritedSandbox.docker
    : {};
  const localNetwork = readString(localDocker.network);
  const inheritedNetwork = readString(inheritedDocker.network);
  pushSandboxPostureValue(entries, params, {
    suffix: "docker/network",
    kind: "containerNetwork",
    value: localNetwork ?? inheritedNetwork ?? "none",
    networkSurface: "docker",
    explicit: localNetwork !== undefined || inheritedNetwork !== undefined,
    inherited: localNetwork === undefined && inheritedNetwork !== undefined,
  });

  pushSandboxDockerProfilePosture(entries, params, localDocker, inheritedDocker, "seccomp");
  pushSandboxDockerProfilePosture(entries, params, localDocker, inheritedDocker, "apparmor");

  pushSandboxBindPosture(entries, params, {
    inheritedBinds: readStringArray(inheritedDocker.binds),
    localBinds: readStringArray(localDocker.binds),
    sourceSuffix: "docker/binds",
    surface: "docker",
  });
}

function pushSandboxBindPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  bindParams: {
    readonly inheritedBinds: readonly string[];
    readonly localBinds: readonly string[];
    readonly sourceSuffix: string;
    readonly surface: "browser" | "docker";
  },
): void {
  const { inheritedBinds, localBinds } = bindParams;
  for (const [index, bind] of [...inheritedBinds, ...localBinds].entries()) {
    const inherited = index < inheritedBinds.length;
    const parsed = splitPolicyBindSpec(bind);
    entries.push({
      id: `${params.id}-${bindParams.surface}-bind-${index}`,
      kind: "containerMount",
      source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/${bindParams.sourceSuffix}/#${
        inherited ? index : index - inheritedBinds.length
      }`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      bind,
      bindHost: parsed?.host,
      bindMode: parsed?.mode ?? "rw",
      bindSurface: bindParams.surface,
      explicit: true,
    });
  }
}

function pushSandboxDockerProfilePosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  localDocker: Record<string, unknown>,
  inheritedDocker: Record<string, unknown>,
  profile: "apparmor" | "seccomp",
): void {
  const key = profile === "apparmor" ? "apparmorProfile" : "seccompProfile";
  const localValue = readString(localDocker[key]);
  const inheritedValue = readString(inheritedDocker[key]);
  const inherited = localValue === undefined && inheritedValue !== undefined;
  const value = localValue ?? inheritedValue;
  entries.push({
    id: `${params.id}-docker-${profile}-profile`,
    kind: "containerSecurityProfile",
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/docker/${key}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    profile,
    ...(value === undefined ? {} : { value }),
    explicit: value !== undefined,
  });
}

function pushSandboxBrowserPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localBrowser =
    !params.sharedSandboxScope && isRecord(params.sandbox.browser) ? params.sandbox.browser : {};
  const inheritedBrowser = isRecord(params.inheritedSandbox.browser)
    ? params.inheritedSandbox.browser
    : {};
  const localEnabled = readBoolean(localBrowser.enabled);
  const inheritedEnabled = readBoolean(inheritedBrowser.enabled);
  const enabled = localEnabled ?? inheritedEnabled ?? false;
  if (!enabled) {
    const disabledInherited = localEnabled === undefined && inheritedEnabled !== undefined;
    if (localEnabled !== undefined || inheritedEnabled !== undefined) {
      entries.push({
        id: `${params.id}-browser-cdp-source-range`,
        kind: "browserCdpSourceRange",
        source: `${disabledInherited ? params.inheritedSourceBase : params.sourceBase}/browser/enabled`,
        scope: params.scope,
        ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
        value: false,
        explicit: true,
      });
    }
    return;
  }
  const hasLocalRange = Object.hasOwn(localBrowser, "cdpSourceRange");
  const localRange = readString(localBrowser.cdpSourceRange);
  const inheritedRange = readString(inheritedBrowser.cdpSourceRange);
  const inherited = !hasLocalRange && inheritedRange !== undefined;
  const value = hasLocalRange ? localRange : inheritedRange;
  entries.push({
    id: `${params.id}-browser-cdp-source-range`,
    kind: "browserCdpSourceRange",
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/browser/cdpSourceRange`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(value === undefined ? {} : { value }),
    explicit: value !== undefined,
  });

  const localNetwork = readString(localBrowser.network);
  const inheritedNetwork = readString(inheritedBrowser.network);
  pushSandboxPostureValue(entries, params, {
    suffix: "browser/network",
    kind: "containerNetwork",
    value: localNetwork ?? inheritedNetwork ?? DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK,
    networkSurface: "browser",
    explicit: localNetwork !== undefined || inheritedNetwork !== undefined,
    inherited: localNetwork === undefined && inheritedNetwork !== undefined,
  });

  const browserBindsConfigured =
    inheritedBrowser.binds !== undefined || localBrowser.binds !== undefined;
  if (browserBindsConfigured) {
    pushSandboxBindPosture(entries, params, {
      inheritedBinds: readStringArray(inheritedBrowser.binds),
      localBinds: readStringArray(localBrowser.binds),
      sourceSuffix: "browser/binds",
      surface: "browser",
    });
  } else if (params.effectiveBackend !== "docker") {
    const localDocker =
      !params.sharedSandboxScope && isRecord(params.sandbox.docker) ? params.sandbox.docker : {};
    const inheritedDocker = isRecord(params.inheritedSandbox.docker)
      ? params.inheritedSandbox.docker
      : {};
    pushSandboxBindPosture(entries, params, {
      inheritedBinds: readStringArray(inheritedDocker.binds),
      localBinds: readStringArray(localDocker.binds),
      sourceSuffix: "docker/binds",
      surface: "browser",
    });
  }
}

function sandboxScopeIsShared(
  sandbox: Record<string, unknown>,
  inheritedSandbox: Record<string, unknown>,
): boolean {
  const localScope = readString(sandbox.scope);
  const inheritedScope = readString(inheritedSandbox.scope);
  const configuredScope = localScope ?? inheritedScope;
  if (configuredScope !== undefined) {
    return configuredScope === "shared";
  }
  const localPerSession = readBoolean(sandbox.perSession);
  const inheritedPerSession = readBoolean(inheritedSandbox.perSession);
  return (localPerSession ?? inheritedPerSession) === false;
}

function pushSandboxPostureValue(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  entry: {
    readonly suffix: string;
    readonly kind: PolicySandboxPostureEvidence["kind"];
    readonly value: string | undefined;
    readonly networkSurface?: "browser" | "docker";
    readonly explicit: boolean;
    readonly inherited: boolean;
  },
): void {
  entries.push({
    id: `${params.id}-${entry.suffix.replaceAll("/", "-")}`,
    kind: entry.kind,
    source: `${entry.inherited ? params.inheritedSourceBase : params.sourceBase}/${entry.suffix}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(entry.value === undefined ? {} : { value: entry.value }),
    ...(entry.networkSurface === undefined ? {} : { networkSurface: entry.networkSurface }),
    explicit: entry.explicit,
  });
}

function splitPolicyBindSpec(
  value: string,
): { readonly host: string; readonly mode: string } | undefined {
  const separator = policyBindSeparatorIndex(value);
  if (separator < 0) {
    return undefined;
  }
  const host = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  const optionsStart = policyBindOptionsSeparatorIndex(rest);
  const options = optionsStart < 0 ? "" : rest.slice(optionsStart + 1);
  const mode = options
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes("ro")
    ? "ro"
    : "rw";
  return { host, mode };
}

function policyBindSeparatorIndex(value: string): number {
  const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(value);
  for (let index = hasDriveLetterPrefix ? 2 : 0; index < value.length; index += 1) {
    if (value[index] === ":") {
      return index;
    }
  }
  return -1;
}

function policyBindOptionsSeparatorIndex(value: string): number {
  const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(value);
  for (let index = hasDriveLetterPrefix ? 2 : 0; index < value.length; index += 1) {
    if (value[index] === ":") {
      return index;
    }
  }
  return -1;
}
