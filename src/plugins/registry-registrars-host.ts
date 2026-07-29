import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import {
  getPluginSessionSchedulerJobGeneration,
  registerPluginSessionSchedulerJob,
} from "./host-hook-runtime.js";
import {
  isPluginJsonValue,
  normalizePluginHostHookId,
  type PluginAgentEventSubscriptionRegistration,
  type PluginControlUiDescriptor,
  type PluginRuntimeLifecycleRegistration,
  type PluginSessionActionRegistration,
  type PluginSessionSchedulerJobRegistration,
  type PluginSessionExtensionRegistration,
  type PluginToolMetadataRegistration,
  type PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import type { PluginRegistryState } from "./registry-state.js";
import type {
  PluginRecord,
  PluginSessionActionRegistryRegistration,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
import { validateJsonSchemaValue, type JsonSchemaValue } from "./schema-validator.js";
import { normalizeSessionEntrySlotKey } from "./session-entry-slot-keys.js";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
} from "./tool-contracts.js";
import type { PluginConversationBindingResolvedEvent } from "./types.js";

const controlUiSurfaces = new Set<PluginControlUiDescriptor["surface"]>([
  "session",
  "tool",
  "run",
  "settings",
  "tab",
  "widget",
]);

function normalizeHostHookString(value: unknown): string {
  return typeof value === "string" ? normalizePluginHostHookId(value) : "";
}

function normalizeOptionalHostHookString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeHostHookStringList(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value.map((item) => normalizeOptionalHostHookString(item));
  if (normalized.some((item) => !item)) {
    return null;
  }
  return normalized as string[];
}

export function createHostRegistrars(state: PluginRegistryState) {
  const { registry, registryParams, pushDiagnostic } = state;

  const validateSessionActionSchema = (
    record: PluginRecord,
    id: string,
    schema: unknown,
  ): schema is JsonSchemaValue => {
    if (schema === undefined) {
      return true;
    }
    if (!isPluginJsonValue(schema)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema must be JSON-compatible: ${id}`,
      });
      return false;
    }
    if (
      typeof schema !== "boolean" &&
      (!schema || typeof schema !== "object" || Array.isArray(schema))
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema must be a JSON schema object or boolean: ${id}`,
      });
      return false;
    }
    try {
      validateJsonSchemaValue({
        schema,
        cacheKey: `plugin-session-action-registration:${record.id}:${id}`,
        value: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema is not valid JSON Schema: ${id}: ${message}`,
      });
      return false;
    }
    return true;
  };

  const registerSessionExtension = (
    record: PluginRecord,
    extension: PluginSessionExtensionRegistration,
  ) => {
    const namespace = normalizeHostHookString(extension.namespace);
    const description = normalizeHostHookString(extension.description);
    const project = extension.project;
    let normalizedSessionEntrySlotKey: string | undefined;
    let invalidMessage: string | undefined;
    if (!namespace || !description) {
      invalidMessage = "session extension registration requires namespace and description";
    } else if (project !== undefined && typeof project !== "function") {
      invalidMessage = "session extension projector must be a function";
    } else if (project?.constructor?.name === "AsyncFunction") {
      invalidMessage = "session extension projector must be synchronous";
    } else if (extension.cleanup !== undefined && typeof extension.cleanup !== "function") {
      invalidMessage = "session extension cleanup must be a function";
    } else if (extension.sessionEntrySlotKey !== undefined) {
      const slotKey = normalizeSessionEntrySlotKey(extension.sessionEntrySlotKey);
      if (!slotKey.ok) {
        invalidMessage = slotKey.error;
      } else {
        normalizedSessionEntrySlotKey = slotKey.key;
      }
    }
    if (invalidMessage) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: invalidMessage,
      });
      return;
    }
    const existing = registry.sessionExtensions.find(
      (entry) => entry.pluginId === record.id && entry.extension.namespace === namespace,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session extension already registered: ${namespace}`,
      });
      return;
    }
    if (normalizedSessionEntrySlotKey) {
      const existingSlot = registry.sessionExtensions.find((entry) => {
        const existingSlotKey = entry.extension.sessionEntrySlotKey;
        if (existingSlotKey === undefined) {
          return false;
        }
        const normalizedExistingSlotKey = normalizeSessionEntrySlotKey(existingSlotKey);
        return (
          normalizedExistingSlotKey.ok &&
          normalizedExistingSlotKey.key === normalizedSessionEntrySlotKey
        );
      });
      if (existingSlot) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `sessionEntrySlotKey already registered: ${normalizedSessionEntrySlotKey}`,
        });
        return;
      }
    }
    registry.sessionExtensions.push({
      pluginId: record.id,
      pluginName: record.name,
      extension: {
        ...extension,
        namespace,
        description,
        ...(normalizedSessionEntrySlotKey
          ? { sessionEntrySlotKey: normalizedSessionEntrySlotKey }
          : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTrustedToolPolicy = (
    record: PluginRecord,
    policy: PluginTrustedToolPolicyRegistration,
  ) => {
    if (!policy || typeof policy !== "object") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "trusted tool policy registration requires id, description, and evaluate()",
      });
      return;
    }
    const id = normalizeHostHookString(policy.id);
    const description = normalizeHostHookString(policy.description);
    if (!id || !description || typeof policy.evaluate !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "trusted tool policy registration requires id, description, and evaluate()",
      });
      return;
    }
    if (
      record.origin !== "bundled" &&
      !(record.contracts?.trustedToolPolicies ?? []).includes(id)
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.trustedToolPolicies for: ${id}`,
      });
      return;
    }
    if (record.origin !== "bundled" && !(record.enabled && record.explicitlyEnabled === true)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must be explicitly enabled to register trusted tool policy: ${id}`,
      });
      return;
    }
    const policies = registry.trustedToolPolicies;
    const existing = policies.find(
      (entry) => entry.pluginId === record.id && entry.policy.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `trusted tool policy already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    const registration: PluginTrustedToolPolicyRegistryRegistration = {
      pluginId: record.id,
      pluginName: record.name,
      policy: { ...policy, id, description },
      origin: record.origin,
      source: record.source,
      rootDir: record.rootDir,
    };
    if (record.origin === "bundled") {
      const firstInstalledPolicyIndex = policies.findIndex((entry) => entry.origin !== "bundled");
      if (firstInstalledPolicyIndex === -1) {
        policies.push(registration);
      } else {
        policies.splice(firstInstalledPolicyIndex, 0, registration);
      }
      return;
    }
    policies.push(registration);
  };

  const registerToolMetadata = (record: PluginRecord, metadata: PluginToolMetadataRegistration) => {
    const toolName = normalizeHostHookString(metadata.toolName);
    if (!toolName) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "tool metadata registration missing toolName",
      });
      return;
    }
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames: normalizePluginToolContractNames(record.contracts),
      toolNames: [toolName],
    });
    if (undeclared.length > 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.tools for tool metadata: ${undeclared.join(", ")}`,
      });
      return;
    }
    // Metadata ownership is scoped to plugin + tool, preventing cross-plugin decoration.
    const existing = registry.toolMetadata.find(
      (entry) => entry.pluginId === record.id && entry.metadata.toolName === toolName,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `tool metadata already registered: ${toolName} (${existing.pluginId})`,
      });
      return;
    }
    const displayName = normalizeOptionalHostHookString(metadata.displayName);
    const description = normalizeOptionalHostHookString(metadata.description);
    const tags = normalizeHostHookStringList(metadata.tags);
    if (
      displayName === "" ||
      description === "" ||
      tags === null ||
      (metadata.risk !== undefined && !["low", "medium", "high"].includes(metadata.risk))
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `tool metadata registration has invalid metadata: ${toolName}`,
      });
      return;
    }
    registry.toolMetadata.push({
      pluginId: record.id,
      pluginName: record.name,
      metadata: {
        ...metadata,
        toolName,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerControlUiDescriptor = (
    record: PluginRecord,
    descriptor: PluginControlUiDescriptor,
  ) => {
    const legacyDescriptor = descriptor as PluginControlUiDescriptor & { name?: unknown };
    const id = normalizeHostHookString(descriptor.id);
    const label = normalizeHostHookString(descriptor.label ?? legacyDescriptor.name);
    const description = normalizeOptionalHostHookString(descriptor.description);
    const placement = normalizeOptionalHostHookString(descriptor.placement);
    const requiredScopes = normalizeHostHookStringList(descriptor.requiredScopes);
    // The flat API predates required surface/label; preserve shipped JS-plugin behavior.
    const surface = typeof descriptor.surface === "string" ? descriptor.surface : "session";
    if (
      !id ||
      !label ||
      !controlUiSurfaces.has(surface) ||
      description === "" ||
      placement === "" ||
      requiredScopes === null
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          "control UI descriptor registration requires id, surface, label, and valid optional fields",
      });
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `control UI descriptor requiredScopes contains unknown operator scope: ${unknownScope}`,
        });
        return;
      }
    }
    if (descriptor.schema !== undefined && !isPluginJsonValue(descriptor.schema)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor schema must be JSON-compatible: ${id}`,
      });
      return;
    }
    const existing = registry.controlUiDescriptors.find(
      (entry) => entry.pluginId === record.id && entry.descriptor.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor already registered: ${id}`,
      });
      return;
    }
    const icon = normalizeOptionalHostHookString(descriptor.icon);
    const tabPath = normalizeOptionalHostHookString(descriptor.path);
    // Reject protocol-relative paths so descriptors cannot iframe external content.
    const isLocalAbsolutePath =
      tabPath === undefined ||
      (tabPath.startsWith("/") && !tabPath.startsWith("//") && !tabPath.startsWith("/\\"));
    if (!isLocalAbsolutePath) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor path must be a gateway-local absolute path: ${id}`,
      });
      return;
    }
    const group =
      descriptor.group === "control" || descriptor.group === "agent" ? descriptor.group : undefined;
    const order =
      typeof descriptor.order === "number" && Number.isFinite(descriptor.order)
        ? descriptor.order
        : undefined;
    registry.controlUiDescriptors.push({
      pluginId: record.id,
      pluginName: record.name,
      descriptor: {
        ...descriptor,
        id,
        surface,
        label,
        ...(description !== undefined ? { description } : {}),
        ...(placement !== undefined ? { placement } : {}),
        ...(requiredScopes !== undefined
          ? { requiredScopes: requiredScopes as OperatorScope[] }
          : {}),
        icon,
        path: tabPath,
        group,
        order,
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerRuntimeLifecycle = (
    record: PluginRecord,
    lifecycle: PluginRuntimeLifecycleRegistration,
  ) => {
    const id = normalizePluginHostHookId(lifecycle.id);
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "runtime lifecycle registration missing id",
      });
      return;
    }
    const existing = registry.runtimeLifecycles.find(
      (entry) => entry.pluginId === record.id && entry.lifecycle.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle already registered: ${id}`,
      });
      return;
    }
    if (lifecycle.cleanup !== undefined && typeof lifecycle.cleanup !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle cleanup must be a function: ${id}`,
      });
      return;
    }
    registry.runtimeLifecycles.push({
      pluginId: record.id,
      pluginName: record.name,
      lifecycle: { ...lifecycle, id },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerAgentEventSubscription = (
    record: PluginRecord,
    subscription: PluginAgentEventSubscriptionRegistration,
  ) => {
    const id = normalizePluginHostHookId(subscription.id);
    if (!id || typeof subscription.handle !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent event subscription registration requires id and handle",
      });
      return;
    }
    const streams = normalizeHostHookStringList(subscription.streams);
    if (streams === null) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription streams must be an array of strings: ${id}`,
      });
      return;
    }
    const existing = registry.agentEventSubscriptions.find(
      (entry) => entry.pluginId === record.id && entry.subscription.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription already registered: ${id}`,
      });
      return;
    }
    registry.agentEventSubscriptions.push({
      pluginId: record.id,
      pluginName: record.name,
      subscription: { ...subscription, id, ...(streams !== undefined ? { streams } : {}) },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSessionSchedulerJob = (
    record: PluginRecord,
    job: PluginSessionSchedulerJobRegistration,
  ) => {
    const jobId = normalizeHostHookString(job.id);
    const sessionKey = normalizeHostHookString(job.sessionKey);
    const kind = normalizeHostHookString(job.kind);
    if (
      jobId &&
      registry.sessionSchedulerJobs.some(
        (entry) => entry.pluginId === record.id && entry.job.id === jobId,
      )
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job already registered: ${jobId}`,
      });
      return undefined;
    }
    if (!jobId || !sessionKey || !kind) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session scheduler job registration requires unique id, sessionKey, and kind",
      });
      return undefined;
    }
    if (job.cleanup !== undefined && typeof job.cleanup !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job cleanup must be a function: ${jobId}`,
      });
      return undefined;
    }
    if (registryParams.activateGlobalSideEffects === false) {
      registry.sessionSchedulerJobs.push({
        pluginId: record.id,
        pluginName: record.name,
        job: { ...job, id: jobId, sessionKey, kind },
        source: record.source,
        rootDir: record.rootDir,
      });
      return { id: jobId, pluginId: record.id, sessionKey, kind };
    }
    const handle = registerPluginSessionSchedulerJob({
      pluginId: record.id,
      pluginName: record.name,
      ownerRegistry: registry,
      job: { ...job, id: jobId, sessionKey, kind },
    });
    if (!handle) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session scheduler job registration requires unique id, sessionKey, and kind",
      });
      return undefined;
    }
    registry.sessionSchedulerJobs.push({
      pluginId: record.id,
      pluginName: record.name,
      job: { ...job, id: handle.id, sessionKey: handle.sessionKey, kind: handle.kind },
      generation: getPluginSessionSchedulerJobGeneration({
        pluginId: record.id,
        jobId: handle.id,
        sessionKey: handle.sessionKey,
      }),
      source: record.source,
      rootDir: record.rootDir,
    });
    return handle;
  };

  const registerSessionAction = (record: PluginRecord, action: PluginSessionActionRegistration) => {
    const id = normalizeHostHookString(action.id);
    const description = normalizeOptionalHostHookString(action.description);
    const requiredScopes = normalizeHostHookStringList(action.requiredScopes);
    if (
      !id ||
      description === "" ||
      requiredScopes === null ||
      typeof action.handler !== "function"
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session action registration requires id, handler, and valid optional fields",
      });
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `session action requiredScopes contains unknown operator scope: ${unknownScope}`,
        });
        return;
      }
    }
    if (!validateSessionActionSchema(record, id, action.schema)) {
      return;
    }
    const existing = registry.sessionActions.find(
      (entry) => entry.pluginId === record.id && entry.action.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action already registered: ${id}`,
      });
      return;
    }
    registry.sessionActions.push({
      pluginId: record.id,
      pluginName: record.name,
      action: {
        ...action,
        id,
        ...(description !== undefined ? { description } : {}),
        ...(requiredScopes !== undefined
          ? { requiredScopes: requiredScopes as OperatorScope[] }
          : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    } satisfies PluginSessionActionRegistryRegistration);
  };

  const registerConversationBindingResolvedHandler = (
    record: PluginRecord,
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => {
    registry.conversationBindingResolvedHandlers.push({
      pluginId: record.id,
      pluginName: record.name,
      pluginRoot: record.rootDir,
      handler,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  return {
    registerSessionExtension,
    registerTrustedToolPolicy,
    registerToolMetadata,
    registerControlUiDescriptor,
    registerRuntimeLifecycle,
    registerAgentEventSubscription,
    registerSessionSchedulerJob,
    registerSessionAction,
    registerConversationBindingResolvedHandler,
  };
}
