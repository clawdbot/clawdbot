/** Collects core config secret refs during runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import {
  resolveConfiguredMediaEntryCapabilities,
  resolveEffectiveMediaEntryCapabilities,
} from "../media-understanding/entry-capabilities.js";
import { buildMediaUnderstandingCapabilityRegistry } from "../media-understanding/provider-capability-registry.js";
import { collectAgentMemorySearchAssignments } from "./runtime-config-collectors-memory.js";
import { collectAgentSandboxAssignments } from "./runtime-config-collectors-sandbox.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { evaluateGatewayAuthSurfaceStates } from "./runtime-gateway-auth-surfaces.js";
import {
  runtimeMediaModelSecretOwnerId,
  runtimeMediaRequestSecretOwnerId,
} from "./runtime-media-secret-owner.js";
import {
  collectSecretInputAssignment,
  collectRuntimeSecretInputAssignment,
  type SecretAssignmentOwner,
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
    const owner = {
      ownerKind: "provider",
      ownerId: normalizeOptionalLowercaseString(providerId) ?? providerId,
      requiredForGateway: false,
      disposition: "isolate",
    } satisfies SecretAssignmentOwner;
    collectRuntimeSecretInputAssignment({
      value: provider.apiKey,
      path: `models.providers.${providerId}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: providerIsActive,
      inactiveReason: "provider is disabled.",
      owner,
      apply: (value) => {
        provider.apiKey = value;
      },
    });
    const headers = isRecord(provider.headers) ? provider.headers : undefined;
    if (headers) {
      for (const [headerKey, headerValue] of Object.entries(headers)) {
        collectRuntimeSecretInputAssignment({
          value: headerValue,
          path: `models.providers.${providerId}.headers.${headerKey}`,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          active: providerIsActive,
          inactiveReason: "provider is disabled.",
          owner,
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
        owner,
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
    collectRuntimeSecretInputAssignment({
      value: entry.apiKey,
      path: `skills.entries.${skillKey}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: entry.enabled !== false,
      inactiveReason: "skill entry is disabled.",
      // Keep this id aligned with isSkillSecretOwnerUnavailable so a failed key
      // removes only its owning skill from prompts and runtime env injection.
      owner: {
        ownerKind: "capability",
        ownerId: `skill:${skillKey}`,
        requiredForGateway: false,
        disposition: "isolate",
      },
      apply: (value) => {
        entry.apiKey = value;
      },
    });
  }
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
  collectTalkProviderApiKeyAssignments({
    providers: talk.providers,
    pathPrefix: "talk.providers",
    defaults: params.defaults,
    context: params.context,
  });
  const realtime = isRecord(talk.realtime) ? talk.realtime : undefined;
  collectTalkProviderApiKeyAssignments({
    providers: realtime?.providers,
    pathPrefix: "talk.realtime.providers",
    defaults: params.defaults,
    context: params.context,
  });
}

function collectTalkProviderApiKeyAssignments(params: {
  providers: unknown;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  if (!isRecord(params.providers)) {
    return;
  }
  for (const [providerId, providerConfig] of Object.entries(params.providers)) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    collectSecretInputAssignment({
      value: providerConfig.apiKey,
      path: `${params.pathPrefix}.${providerId}.apiKey`,
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
    const ingressAuthOwner = {
      ownerKind: "gateway",
      ownerId: "ingress-auth",
      requiredForGateway: true,
      disposition: "fail-closed",
    } satisfies SecretAssignmentOwner;
    collectRuntimeSecretInputAssignment({
      value: auth.token,
      path: "gateway.auth.token",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.auth.token"].active,
      inactiveReason: gatewaySurfaceStates["gateway.auth.token"].reason,
      owner: ingressAuthOwner,
      apply: (value) => {
        auth.token = value;
      },
    });
    collectRuntimeSecretInputAssignment({
      value: auth.password,
      path: "gateway.auth.password",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.auth.password"].active,
      inactiveReason: gatewaySurfaceStates["gateway.auth.password"].reason,
      owner: ingressAuthOwner,
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
  owner?: SecretAssignmentOwner;
}): void {
  const headers = isRecord(params.request.headers) ? params.request.headers : undefined;
  if (headers) {
    for (const [headerKey, headerValue] of Object.entries(headers)) {
      collectRuntimeSecretInputAssignment({
        value: headerValue,
        path: `${params.pathPrefix}.headers.${headerKey}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
        owner: params.owner,
        apply: (value) => {
          headers[headerKey] = value;
        },
      });
    }
  }

  const auth = isRecord(params.request.auth) ? params.request.auth : undefined;
  if (auth) {
    collectRuntimeSecretInputAssignment({
      value: auth.token,
      path: `${params.pathPrefix}.auth.token`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      owner: params.owner,
      apply: (value) => {
        auth.token = value;
      },
    });
    collectRuntimeSecretInputAssignment({
      value: auth.value,
      path: `${params.pathPrefix}.auth.value`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      owner: params.owner,
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
      collectRuntimeSecretInputAssignment({
        value: tls[key],
        path: `${pathPrefix}.${key}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
        owner: params.owner,
        apply: (value) => {
          tls[key] = value;
        },
      });
    }
  };

  if (params.collectTransportSecrets !== false) {
    // Transport credentials can live below direct TLS or proxy TLS config; model-provider
    // request surfaces opt out when those nested transport secrets are owned elsewhere.
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
    resolveOwnerId: (index: number) => string,
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
        owner: {
          ownerKind: "capability",
          ownerId: resolveOwnerId(index),
          requiredForGateway: false,
          disposition: "isolate",
        },
      });
    });
  };

  collectModelAssignments(
    media.models,
    "tools.media.models",
    (index) => runtimeMediaModelSecretOwnerId({ source: "shared", index }),
    (rawModel) => {
      const entry = rawModel as MediaUnderstandingModelConfig;
      const configuredCapabilities = resolveConfiguredMediaEntryCapabilities(entry);
      // Shared models are active only for enabled capabilities; when the config omits explicit
      // capabilities, provider metadata is the contract for which media sections can use it.
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
    },
  );

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
        owner: {
          ownerKind: "capability",
          ownerId: runtimeMediaRequestSecretOwnerId(capability),
          requiredForGateway: false,
          disposition: "isolate",
        },
      });
    }
    collectModelAssignments(
      section?.models,
      `tools.media.${capability}.models`,
      (index) => runtimeMediaModelSecretOwnerId({ source: "capability", capability, index }),
      (rawModel) => ({
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
      }),
    );
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

function collectAgentTtsAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const agents = params.config.agents as Record<string, unknown> | undefined;
  const list = agents?.list;
  if (!Array.isArray(list)) {
    return;
  }
  for (const [index, entry] of list.entries()) {
    if (!isRecord(entry) || !isRecord(entry.tts)) {
      continue;
    }
    collectTtsApiKeyAssignments({
      tts: entry.tts,
      pathPrefix: `agents.list.${index}.tts`,
      defaults: params.defaults,
      context: params.context,
    });
  }
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
  collectRuntimeSecretInputAssignment({
    value: cron.webhookToken,
    path: "cron.webhookToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    owner: {
      ownerKind: "capability",
      ownerId: "cron-webhook",
      requiredForGateway: false,
      disposition: "isolate",
    },
    apply: (value) => {
      cron.webhookToken = value;
    },
  });
}

/** Collects SecretRef assignments from core non-plugin config surfaces. */
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
  collectAgentSandboxAssignments(params);
  collectMessagesTtsAssignments(params);
  collectAgentTtsAssignments(params);
  collectCronAssignments(params);
  collectMediaRequestAssignments(params);
}
