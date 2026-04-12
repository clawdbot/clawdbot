import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import {
  resolveConfiguredMediaEntryCapabilities,
  resolveEffectiveMediaEntryCapabilities,
} from "../media-understanding/entry-capabilities.js";
import { buildMediaUnderstandingCapabilityRegistry } from "../media-understanding/provider-capability-registry.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { evaluateGatewayAuthSurfaceStates } from "./runtime-gateway-auth-surfaces.js";
import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type ProviderLike = {
  apiKey?: unknown;
  headers?: unknown;
  request?: unknown;
  enabled?: unknown;
};

type SkillEntryLike = {
  apiKey?: unknown;
  enabled?: unknown;
};

type ProviderRequestLike = {
  headers?: unknown;
  auth?: unknown;
  proxy?: unknown;
  tls?: unknown;
};

function collectModelProviderAssignments(params: {
  providers: Record<string, ProviderLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [providerId, provider] of Object.entries(params.providers)) {
    const providerIsActive = provider.enabled !== false;
    collectSecretInputAssignment({
      value: provider.apiKey,
      path: `models.providers.${providerId}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: providerIsActive,
      inactiveReason: "provider is disabled.",
      apply: (value) => {
        provider.apiKey = value;
      },
    });
    const headers = isRecord(provider.headers) ? provider.headers : undefined;
    if (headers) {
      for (const [headerKey, headerValue] of Object.entries(headers)) {
        collectSecretInputAssignment({
          value: headerValue,
          path: `models.providers.${providerId}.headers.${headerKey}`,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          active: providerIsActive,
          inactiveReason: "provider is disabled.",
          apply: (value) => {
            headers[headerKey] = value;
          },
        });
      }
    }

    const request = isRecord(provider.request) ? provider.request : undefined;
    if (request) {
      collectProviderRequestAssignments({
        request,
        pathPrefix: `models.providers.${providerId}.request`,
        defaults: params.defaults,
        context: params.context,
        active: providerIsActive,
        inactiveReason: "provider is disabled.",
        collectTransportSecrets: true,
      });
    }
  }
}

function collectSkillAssignments(params: {
  entries: Record<string, SkillEntryLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [skillKey, entry] of Object.entries(params.entries)) {
    collectSecretInputAssignment({
      value: entry.apiKey,
      path: `skills.entries.${skillKey}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: entry.enabled !== false,
      inactiveReason: "skill entry is disabled.",
      apply: (value) => {
        entry.apiKey = value;
      },
    });
  }
}

function collectAgentMemorySearchAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const agents = params.config.agents as Record<string, unknown> | undefined;
  if (!isRecord(agents)) {
    return;
  }
  const defaultsConfig = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsMemorySearch = isRecord(defaultsConfig?.memorySearch)
    ? defaultsConfig.memorySearch
    : undefined;
  const defaultsEnabled = defaultsMemorySearch?.enabled !== false;

  const list = Array.isArray(agents.list) ? agents.list : [];
  let hasEnabledAgentWithoutOverride = false;
  for (const rawAgent of list) {
    if (!isRecord(rawAgent)) {
      continue;
    }
    if (rawAgent.enabled === false) {
      continue;
    }
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    if (memorySearch?.enabled === false) {
      continue;
    }
    if (!memorySearch || !Object.prototype.hasOwnProperty.call(memorySearch, "remote")) {
      hasEnabledAgentWithoutOverride = true;
      continue;
    }
    const remote = isRecord(memorySearch.remote) ? memorySearch.remote : undefined;
    if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) {
      hasEnabledAgentWithoutOverride = true;
      continue;
    }
  }

  if (defaultsMemorySearch && isRecord(defaultsMemorySearch.remote)) {
    const remote = defaultsMemorySearch.remote;
    collectSecretInputAssignment({
      value: remote.apiKey,
      path: "agents.defaults.memorySearch.remote.apiKey",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: defaultsEnabled && (hasEnabledAgentWithoutOverride || list.length === 0),
      inactiveReason: hasEnabledAgentWithoutOverride
        ? undefined
        : "all enabled agents override memorySearch.remote.apiKey.",
      apply: (value) => {
        remote.apiKey = value;
      },
    });
  }

  list.forEach((rawAgent, index) => {
    if (!isRecord(rawAgent)) {
      return;
    }
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    if (!memorySearch) {
      return;
    }
    const remote = isRecord(memorySearch.remote) ? memorySearch.remote : undefined;
    if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) {
      return;
    }
    const enabled = rawAgent.enabled !== false && memorySearch.enabled !== false;
    collectSecretInputAssignment({
      value: remote.apiKey,
      path: `agents.list.${index}.memorySearch.remote.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: "agent or memorySearch override is disabled.",
      apply: (value) => {
        remote.apiKey = value;
      },
    });
  });
}

function collectTalkAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const talk = params.config.talk as Record<string, unknown> | undefined;
  if (!isRecord(talk)) {
    return;
  }
  collectSecretInputAssignment({
    value: talk.apiKey,
    path: "talk.apiKey",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    apply: (value) => {
      talk.apiKey = value;
    },
  });
  const providers = talk.providers;
  if (!isRecord(providers)) {
    return;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    collectSecretInputAssignment({
      value: providerConfig.apiKey,
      path: `talk.providers.${providerId}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      apply: (value) => {
        providerConfig.apiKey = value;
      },
    });
  }
}

function collectGatewayAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return;
  }
  const auth = isRecord(gateway.auth) ? gateway.auth : undefined;
  const remote = isRecord(gateway.remote) ? gateway.remote : undefined;
  const gatewaySurfaceStates = evaluateGatewayAuthSurfaceStates({
    config: params.config,
    env: params.context.env,
    defaults: params.defaults,
  });
  if (auth) {
    collectSecretInputAssignment({
      value: auth.token,
      path: "gateway.auth.token",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.auth.token"].active,
      inactiveReason: gatewaySurfaceStates["gateway.auth.token"].reason,
      apply: (value) => {
        auth.token = value;
      },
    });
    collectSecretInputAssignment({
      value: auth.password,
      path: "gateway.auth.password",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.auth.password"].active,
      inactiveReason: gatewaySurfaceStates["gateway.auth.password"].reason,
      apply: (value) => {
        auth.password = value;
      },
    });
  }
  if (remote) {
    collectSecretInputAssignment({
      value: remote.token,
      path: "gateway.remote.token",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.remote.token"].active,
      inactiveReason: gatewaySurfaceStates["gateway.remote.token"].reason,
      apply: (value) => {
        remote.token = value;
      },
    });
    collectSecretInputAssignment({
      value: remote.password,
      path: "gateway.remote.password",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.remote.password"].active,
      inactiveReason: gatewaySurfaceStates["gateway.remote.password"].reason,
      apply: (value) => {
        remote.password = value;
      },
    });
  }
}

function collectProviderRequestAssignments(params: {
  request: ProviderRequestLike;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
  collectTransportSecrets?: boolean;
}): void {
  const headers = isRecord(params.request.headers) ? params.request.headers : undefined;
  if (headers) {
    for (const [headerKey, headerValue] of Object.entries(headers)) {
      collectSecretInputAssignment({
        value: headerValue,
        path: `${params.pathPrefix}.headers.${headerKey}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
        apply: (value) => {
          headers[headerKey] = value;
        },
      });
    }
  }

  const auth = isRecord(params.request.auth) ? params.request.auth : undefined;
  if (auth) {
    collectSecretInputAssignment({
      value: auth.token,
      path: `${params.pathPrefix}.auth.token`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      apply: (value) => {
        auth.token = value;
      },
    });
    collectSecretInputAssignment({
      value: auth.value,
      path: `${params.pathPrefix}.auth.value`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      apply: (value) => {
        auth.value = value;
      },
    });
  }

  const collectTlsAssignments = (tls: Record<string, unknown> | undefined, pathPrefix: string) => {
    if (!tls) {
      return;
    }
    for (const key of ["ca", "cert", "key", "passphrase"] as const) {
      collectSecretInputAssignment({
        value: tls[key],
        path: `${pathPrefix}.${key}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
        apply: (value) => {
          tls[key] = value;
        },
      });
    }
  };

  if (params.collectTransportSecrets !== false) {
    collectTlsAssignments(
      isRecord(params.request.tls) ? params.request.tls : undefined,
      `${params.pathPrefix}.tls`,
    );
    const proxy = isRecord(params.request.proxy) ? params.request.proxy : undefined;
    collectTlsAssignments(
      isRecord(proxy?.tls) ? proxy.tls : undefined,
      `${params.pathPrefix}.proxy.tls`,
    );
  }
}

function collectMediaRequestAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const tools = isRecord(params.config.tools) ? params.config.tools : undefined;
  const media = isRecord(tools?.media) ? tools.media : undefined;
  if (!media) {
    return;
  }

  let providerRegistry: ReturnType<typeof buildMediaUnderstandingCapabilityRegistry> | undefined;
  const getProviderRegistry = () => {
    providerRegistry ??= buildMediaUnderstandingCapabilityRegistry(params.config);
    return providerRegistry;
  };
  const capabilityKeys = ["audio", "image", "video"] as const;
  const isCapabilityEnabled = (capability: (typeof capabilityKeys)[number]) =>
    (isRecord(media[capability]) ? media[capability] : undefined)?.enabled !== false;

  const collectModelAssignments = (
    models: unknown,
    pathPrefix: string,
    resolveActivity: (rawModel: Record<string, unknown>) => {
      active: boolean;
      inactiveReason: string;
    },
  ) => {
    if (!Array.isArray(models)) {
      return;
    }
    models.forEach((rawModel, index) => {
      if (!isRecord(rawModel) || !isRecord(rawModel.request)) {
        return;
      }
      const { active, inactiveReason } = resolveActivity(rawModel);
      collectProviderRequestAssignments({
        request: rawModel.request,
        pathPrefix: `${pathPrefix}.${index}.request`,
        defaults: params.defaults,
        context: params.context,
        active,
        inactiveReason,
      });
    });
  };

  collectModelAssignments(media.models, "tools.media.models", (rawModel) => {
    const entry = rawModel as MediaUnderstandingModelConfig;
    const configuredCapabilities = resolveConfiguredMediaEntryCapabilities(entry);
    const capabilities =
      configuredCapabilities ??
      resolveEffectiveMediaEntryCapabilities({
        entry,
        source: "shared",
        providerRegistry: getProviderRegistry(),
      });
    if (!capabilities || capabilities.length === 0) {
      return {
        active: false,
        inactiveReason:
          "shared media model does not declare capabilities and none could be inferred from its provider.",
      };
    }
    return {
      active: capabilities.some((capability) => isCapabilityEnabled(capability)),
      inactiveReason: `all configured media capabilities for this shared model are disabled: ${capabilities.join(", ")}.`,
    };
  });

  for (const capability of capabilityKeys) {
    const section = isRecord(media[capability]) ? media[capability] : undefined;
    const active = isCapabilityEnabled(capability);
    const inactiveReason = `${capability} media understanding is disabled.`;
    if (section && isRecord(section.request)) {
      collectProviderRequestAssignments({
        request: section.request,
        pathPrefix: `tools.media.${capability}.request`,
        defaults: params.defaults,
        context: params.context,
        active,
        inactiveReason,
      });
    }
    collectModelAssignments(section?.models, `tools.media.${capability}.models`, (rawModel) => ({
      active:
        active &&
        (() => {
          const entry = rawModel as MediaUnderstandingModelConfig;
          const configuredCapabilities = resolveConfiguredMediaEntryCapabilities(entry);
          return configuredCapabilities ? configuredCapabilities.includes(capability) : true;
        })(),
      inactiveReason: active
        ? `${capability} media model is filtered out by its configured capabilities.`
        : inactiveReason,
    }));
  }
}

function collectMessagesTtsAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const messages = params.config.messages as Record<string, unknown> | undefined;
  if (!isRecord(messages) || !isRecord(messages.tts)) {
    return;
  }
  collectTtsApiKeyAssignments({
    tts: messages.tts,
    pathPrefix: "messages.tts",
    defaults: params.defaults,
    context: params.context,
  });
}

function collectCronAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const cron = params.config.cron as Record<string, unknown> | undefined;
  if (!isRecord(cron)) {
    return;
  }
  collectSecretInputAssignment({
    value: cron.webhookToken,
    path: "cron.webhookToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    apply: (value) => {
      cron.webhookToken = value;
    },
  });
}

function collectSandboxSshAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const agents = isRecord(params.config.agents) ? params.config.agents : undefined;
  if (!agents) {
    return;
  }
  const defaultsAgent = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsSandbox = isRecord(defaultsAgent?.sandbox) ? defaultsAgent.sandbox : undefined;
  const defaultsSsh = isRecord(defaultsSandbox?.ssh)
    ? (defaultsSandbox.ssh as Record<string, unknown>)
    : undefined;
  const defaultsBackend =
    typeof defaultsSandbox?.backend === "string" ? defaultsSandbox.backend : undefined;
  const defaultsMode = typeof defaultsSandbox?.mode === "string" ? defaultsSandbox.mode : undefined;

  const inheritedDefaultsUsage = {
    identityData: false,
    certificateData: false,
    knownHostsData: false,
  };

  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((rawAgent, index) => {
    const agentRecord = isRecord(rawAgent) ? (rawAgent as Record<string, unknown>) : null;
    if (!agentRecord || agentRecord.enabled === false) {
      return;
    }
    const sandbox = isRecord(agentRecord.sandbox) ? agentRecord.sandbox : undefined;
    const ssh = isRecord(sandbox?.ssh) ? sandbox.ssh : undefined;
    const effectiveBackend =
      (typeof sandbox?.backend === "string" ? sandbox.backend : undefined) ??
      defaultsBackend ??
      "docker";
    const effectiveMode =
      (typeof sandbox?.mode === "string" ? sandbox.mode : undefined) ?? defaultsMode ?? "off";
    const active =
      normalizeOptionalLowercaseString(effectiveBackend) === "ssh" && effectiveMode !== "off";
    for (const key of ["identityData", "certificateData", "knownHostsData"] as const) {
      if (ssh && Object.prototype.hasOwnProperty.call(ssh, key)) {
        collectSecretInputAssignment({
          value: ssh[key],
          path: `agents.list.${index}.sandbox.ssh.${key}`,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          active,
          inactiveReason: "sandbox SSH backend is not active for this agent.",
          apply: (value) => {
            ssh[key] = value;
          },
        });
      } else if (active) {
        inheritedDefaultsUsage[key] = true;
      }
    }
  });

  if (!defaultsSsh) {
    return;
  }

  const defaultsActive =
    (normalizeOptionalLowercaseString(defaultsBackend) === "ssh" && defaultsMode !== "off") ||
    inheritedDefaultsUsage.identityData ||
    inheritedDefaultsUsage.certificateData ||
    inheritedDefaultsUsage.knownHostsData;
  for (const key of ["identityData", "certificateData", "knownHostsData"] as const) {
    collectSecretInputAssignment({
      value: defaultsSsh[key],
      path: `agents.defaults.sandbox.ssh.${key}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: defaultsActive || inheritedDefaultsUsage[key],
      inactiveReason: "sandbox SSH backend is not active.",
      apply: (value) => {
        defaultsSsh[key] = value;
      },
    });
  }
}

export function collectCoreConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const providers = params.config.models?.providers as Record<string, ProviderLike> | undefined;
  if (providers) {
    collectModelProviderAssignments({
      providers,
      defaults: params.defaults,
      context: params.context,
    });
  }

  const skillEntries = params.config.skills?.entries as Record<string, SkillEntryLike> | undefined;
  if (skillEntries) {
    collectSkillAssignments({
      entries: skillEntries,
      defaults: params.defaults,
      context: params.context,
    });
  }

  collectAgentMemorySearchAssignments(params);
  collectTalkAssignments(params);
  collectGatewayAssignments(params);
  collectSandboxSshAssignments(params);
  collectMessagesTtsAssignments(params);
  collectCronAssignments(params);
  collectMediaRequestAssignments(params);
}
