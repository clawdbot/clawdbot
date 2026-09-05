import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import { createPluginBoardWidgetContentKindRegistrar } from "./board-widget-content-kinds.js";
import { publishPluginSessionSchedulerJobs } from "./host-hook-runtime.js";
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
import { validateControlUiNativeRoutePlacement } from "./registry-control-ui-policy.js";
import {
  getPluginRecordRegistry,
  isPluginRecordActive,
  isPluginRegistryRetired,
} from "./registry-lifecycle.js";
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
import { normalizePluginToolMatcher } from "./tool-hook-matcher.js";
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
  const { registry, createRegistration, pushDiagnostic, reportRegistrationError } = state;

  const validateSessionActionSchema = (
    record: PluginRecord,
    id: string,
    schema: unknown,
  ): schema is JsonSchemaValue => {
    if (schema === undefined) {
      return true;
    }
    if (!isPluginJsonValue(schema)) {
      reportRegistrationError(record, `session action schema must be JSON-compatible: ${id}`);
      return false;
    }
    if (
      typeof schema !== "boolean" &&
      (!schema || typeof schema !== "object" || Array.isArray(schema))
    ) {
      reportRegistrationError(
        record,
        `session action schema must be a JSON schema object or boolean: ${id}`,
      );
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
      reportRegistrationError(
        record,
        `session action schema is not valid JSON Schema: ${id}: ${message}`,
      );
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
      reportRegistrationError(record, invalidMessage);
      return;
    }
    const existing = registry.sessionExtensions.find(
      (entry) => entry.pluginId === record.id && entry.extension.namespace === namespace,
    );
    if (existing) {
      reportRegistrationError(record, `session extension already registered: ${namespace}`);
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
        reportRegistrationError(
          record,
          `sessionEntrySlotKey already registered: ${normalizedSessionEntrySlotKey}`,
        );
        return;
      }
    }
    registry.sessionExtensions.push(
      createRegistration(record, {
        extension: {
          ...extension,
          namespace,
          description,
          ...(normalizedSessionEntrySlotKey
            ? { sessionEntrySlotKey: normalizedSessionEntrySlotKey }
            : {}),
        },
      }),
    );
  };

  const registerTrustedToolPolicy = (
    record: PluginRecord,
    policy: PluginTrustedToolPolicyRegistration,
  ) => {
    if (!policy || typeof policy !== "object") {
      reportRegistrationError(
        record,
        "trusted tool policy registration requires id, description, and evaluate()",
      );
      return;
    }
    const id = normalizeHostHookString(policy.id);
    const description = normalizeHostHookString(policy.description);
    const matcher = normalizePluginToolMatcher(policy.matcher);
    if (!id || !description || typeof policy.evaluate !== "function") {
      reportRegistrationError(
        record,
        "trusted tool policy registration requires id, description, and evaluate()",
      );
      return;
    }
    if (
      record.origin !== "bundled" &&
      !(record.contracts?.trustedToolPolicies ?? []).includes(id)
    ) {
      reportRegistrationError(
        record,
        `plugin must declare contracts.trustedToolPolicies for: ${id}`,
      );
      return;
    }
    if (record.origin !== "bundled" && !(record.enabled && record.explicitlyEnabled === true)) {
      reportRegistrationError(
        record,
        `plugin must be explicitly enabled to register trusted tool policy: ${id}`,
      );
      return;
    }
    const policies = registry.trustedToolPolicies;
    const existing = policies.find(
      (entry) => entry.pluginId === record.id && entry.policy.id === id,
    );
    if (existing) {
      reportRegistrationError(
        record,
        `trusted tool policy already registered: ${id} (${existing.pluginId})`,
      );
      return;
    }
    const registration: PluginTrustedToolPolicyRegistryRegistration = createRegistration(record, {
      policy: { ...policy, id, description, ...(matcher ? { matcher } : {}) },
      origin: record.origin,
    });
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
      reportRegistrationError(record, "tool metadata registration missing toolName");
      return;
    }
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames: normalizePluginToolContractNames(record.contracts),
      toolNames: [toolName],
    });
    if (undeclared.length > 0) {
      reportRegistrationError(
        record,
        `plugin must declare contracts.tools for tool metadata: ${undeclared.join(", ")}`,
      );
      return;
    }
    // Metadata ownership is scoped to plugin + tool, preventing cross-plugin decoration.
    const existing = registry.toolMetadata.find(
      (entry) => entry.pluginId === record.id && entry.metadata.toolName === toolName,
    );
    if (existing) {
      reportRegistrationError(
        record,
        `tool metadata already registered: ${toolName} (${existing.pluginId})`,
      );
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
      reportRegistrationError(
        record,
        `tool metadata registration has invalid metadata: ${toolName}`,
      );
      return;
    }
    registry.toolMetadata.push(
      createRegistration(record, {
        metadata: {
          ...metadata,
          toolName,
          ...(displayName !== undefined ? { displayName } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
        },
      }),
    );
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
      reportRegistrationError(
        record,
        "control UI descriptor registration requires id, surface, label, and valid optional fields",
      );
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        reportRegistrationError(
          record,
          `control UI descriptor requiredScopes contains unknown operator scope: ${unknownScope}`,
        );
        return;
      }
    }
    if (!validateControlUiNativeRoutePlacement({ record, placement, pushDiagnostic })) {
      return;
    }
    if (descriptor.schema !== undefined && !isPluginJsonValue(descriptor.schema)) {
      reportRegistrationError(
        record,
        `control UI descriptor schema must be JSON-compatible: ${id}`,
      );
      return;
    }
    const existing = registry.controlUiDescriptors.find(
      (entry) => entry.pluginId === record.id && entry.descriptor.id === id,
    );
    if (existing) {
      reportRegistrationError(record, `control UI descriptor already registered: ${id}`);
      return;
    }
    const icon = normalizeOptionalHostHookString(descriptor.icon);
    const tabPath = normalizeOptionalHostHookString(descriptor.path);
    // Reject protocol-relative paths so descriptors cannot iframe external content.
    const isLocalAbsolutePath =
      tabPath === undefined ||
      (tabPath.startsWith("/") && !tabPath.startsWith("//") && !tabPath.startsWith("/\\"));
    if (!isLocalAbsolutePath) {
      reportRegistrationError(
        record,
        `control UI descriptor path must be a gateway-local absolute path: ${id}`,
      );
      return;
    }
    const group =
      descriptor.group === "control" || descriptor.group === "agent" ? descriptor.group : undefined;
    const order =
      typeof descriptor.order === "number" && Number.isFinite(descriptor.order)
        ? descriptor.order
        : undefined;
    registry.controlUiDescriptors.push(
      createRegistration(record, {
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
      }),
    );
  };

  const registerRuntimeLifecycle = (
    record: PluginRecord,
    lifecycle: PluginRuntimeLifecycleRegistration,
  ) => {
    const id = normalizePluginHostHookId(lifecycle.id);
    if (!id) {
      reportRegistrationError(record, "runtime lifecycle registration missing id");
      return;
    }
    const existing = registry.runtimeLifecycles.find(
      (entry) => entry.pluginId === record.id && entry.lifecycle.id === id,
    );
    if (existing) {
      reportRegistrationError(record, `runtime lifecycle already registered: ${id}`);
      return;
    }
    if (lifecycle.cleanup !== undefined && typeof lifecycle.cleanup !== "function") {
      reportRegistrationError(record, `runtime lifecycle cleanup must be a function: ${id}`);
      return;
    }
    registry.runtimeLifecycles.push(
      createRegistration(record, {
        lifecycle: { ...lifecycle, id },
      }),
    );
  };

  const registerAgentEventSubscription = (
    record: PluginRecord,
    subscription: PluginAgentEventSubscriptionRegistration,
  ) => {
    const id = normalizePluginHostHookId(subscription.id);
    if (!id || typeof subscription.handle !== "function") {
      reportRegistrationError(
        record,
        "agent event subscription registration requires id and handle",
      );
      return;
    }
    const streams = normalizeHostHookStringList(subscription.streams);
    if (streams === null) {
      reportRegistrationError(
        record,
        `agent event subscription streams must be an array of strings: ${id}`,
      );
      return;
    }
    const existing = registry.agentEventSubscriptions.find(
      (entry) => entry.pluginId === record.id && entry.subscription.id === id,
    );
    if (existing) {
      reportRegistrationError(record, `agent event subscription already registered: ${id}`);
      return;
    }
    registry.agentEventSubscriptions.push(
      createRegistration(record, {
        subscription: { ...subscription, id, ...(streams !== undefined ? { streams } : {}) },
      }),
    );
  };

  const registerSessionSchedulerJob = (
    record: PluginRecord,
    job: PluginSessionSchedulerJobRegistration,
  ) => {
    const owner = getPluginRecordRegistry(registry, record);
    const active = isPluginRecordActive(registry, record);
    if (!active && isPluginRegistryRetired(registry)) {
      return undefined;
    }
    const jobId = normalizeHostHookString(job.id);
    const sessionKey = normalizeHostHookString(job.sessionKey);
    const kind = normalizeHostHookString(job.kind);
    if (
      jobId &&
      owner.sessionSchedulerJobs.some(
        (entry) => entry.pluginId === record.id && entry.job.id === jobId,
      )
    ) {
      reportRegistrationError(record, `session scheduler job already registered: ${jobId}`);
      return undefined;
    }
    if (!jobId || !sessionKey || !kind) {
      reportRegistrationError(
        record,
        "session scheduler job registration requires unique id, sessionKey, and kind",
      );
      return undefined;
    }
    if (job.cleanup !== undefined && typeof job.cleanup !== "function") {
      reportRegistrationError(record, `session scheduler job cleanup must be a function: ${jobId}`);
      return undefined;
    }
    // Publication owns scheduler registration; candidate validation cannot replace live jobs.
    owner.sessionSchedulerJobs.push(
      createRegistration(record, {
        job: { ...job, id: jobId, sessionKey, kind },
      }),
    );
    if (active) {
      publishPluginSessionSchedulerJobs(owner);
    }
    return { id: jobId, pluginId: record.id, sessionKey, kind };
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
      reportRegistrationError(
        record,
        "session action registration requires id, handler, and valid optional fields",
      );
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        reportRegistrationError(
          record,
          `session action requiredScopes contains unknown operator scope: ${unknownScope}`,
        );
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
      reportRegistrationError(record, `session action already registered: ${id}`);
      return;
    }
    registry.sessionActions.push(
      createRegistration(record, {
        action: {
          ...action,
          id,
          ...(description !== undefined ? { description } : {}),
          ...(requiredScopes !== undefined
            ? { requiredScopes: requiredScopes as OperatorScope[] }
            : {}),
        },
      }) satisfies PluginSessionActionRegistryRegistration,
    );
  };

  const registerConversationBindingResolvedHandler = (
    record: PluginRecord,
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => {
    registry.conversationBindingResolvedHandlers.push(
      createRegistration(record, {
        pluginRoot: record.rootDir,
        handler,
      }),
    );
  };

  return {
    registerSessionExtension,
    registerTrustedToolPolicy,
    registerToolMetadata,
    registerControlUiDescriptor,
    registerBoardWidgetContentKind: createPluginBoardWidgetContentKindRegistrar(registry),
    registerRuntimeLifecycle,
    registerAgentEventSubscription,
    registerSessionSchedulerJob,
    registerSessionAction,
    registerConversationBindingResolvedHandler,
  };
}
