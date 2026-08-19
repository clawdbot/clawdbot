import { recordMemoryEnterpriseRoleAccessDecisions } from "../state/memory-enterprise-access-audit.js";
import type { EnterpriseIdentityMembershipSource } from "./enterprise-identity-provider-types.js";
import type { MemoryEnterpriseAccessAuditReporter } from "./memory-enterprise-access-audit-reporter.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { hasKind } from "./slots.js";
import type { OpenClawPluginApi } from "./types.js";

const MAX_ENTERPRISE_EVIDENCE_AGE_MS = 24 * 60 * 60_000;

function isNormalizedText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && value.trim() === value;
}

function isNormalizedTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNormalizedText);
}

function isHttpsUrl(value: unknown): value is string {
  if (!isNormalizedText(value)) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isEnterpriseOidcCallbackUrl(value: unknown): boolean {
  if (!isHttpsUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.pathname === "/memory/oidc/callback" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
}

function hasValidEnterpriseMembershipSource(value: EnterpriseIdentityMembershipSource): boolean {
  if (!Number.isSafeInteger(value.maxGroups) || value.maxGroups < 1 || value.maxGroups > 1_000) {
    return false;
  }
  if (value.kind === "google-workspace-directory") {
    return (
      isNormalizedText(value.verifiedEmailClaim) &&
      isNormalizedTextList(value.roleGroupResourceNames) &&
      value.roleGroupResourceNames.length > 0 &&
      value.roleGroupResourceNames.every((group) => /^groups\/[^/\s]+$/u.test(group)) &&
      (value.customerId === undefined || /^C[\w-]+$/u.test(value.customerId))
    );
  }
  return (
    isNormalizedText(value.claim) &&
    typeof value.required === "boolean" &&
    isNormalizedTextList(value.roleGroupIds) &&
    value.roleGroupIds.length > 0 &&
    (value.incompleteIndicators ?? []).every(
      (indicator) =>
        isNormalizedText(indicator.claim) &&
        (indicator.kind === "truthy-claim" ||
          (indicator.kind === "nested-key" && isNormalizedText(indicator.key))),
    )
  );
}

function hasValidEnterpriseAuthority(
  provider: Parameters<OpenClawPluginApi["registerEnterpriseIdentityProvider"]>[0],
): boolean {
  if (typeof provider.resolveAuthorizationCodeClientSecret !== "function") {
    return false;
  }
  return provider.authorities.every((authority) => {
    if (
      !isHttpsUrl(authority.issuer) ||
      !isNormalizedTextList(authority.acceptedIssuerAliases ?? []) ||
      !isNormalizedText(authority.tenantId) ||
      !isNormalizedTextList(authority.audiences) ||
      authority.audiences.length === 0 ||
      !isHttpsUrl(authority.jwksUri) ||
      authority.algorithm !== "RS256" ||
      !Number.isSafeInteger(authority.maxSnapshotAgeMs) ||
      authority.maxSnapshotAgeMs <= 0 ||
      authority.maxSnapshotAgeMs > MAX_ENTERPRISE_EVIDENCE_AGE_MS ||
      !Number.isSafeInteger(authority.assurance.maxAuthenticationAgeMs) ||
      authority.assurance.maxAuthenticationAgeMs <= 0 ||
      authority.assurance.maxAuthenticationAgeMs > MAX_ENTERPRISE_EVIDENCE_AGE_MS ||
      !isNormalizedTextList(authority.assurance.acceptedAcrValues ?? []) ||
      !isNormalizedTextList(authority.assurance.requiredAmrValues ?? []) ||
      !isNormalizedText(authority.authorizationCodeFlow.clientId) ||
      !authority.audiences.includes(authority.authorizationCodeFlow.clientId) ||
      !isHttpsUrl(authority.authorizationCodeFlow.authorizationEndpoint) ||
      !isHttpsUrl(authority.authorizationCodeFlow.tokenEndpoint) ||
      !isEnterpriseOidcCallbackUrl(authority.authorizationCodeFlow.redirectUri) ||
      !isNormalizedTextList(authority.authorizationCodeFlow.scopes) ||
      authority.authorizationCodeFlow.scopes.length === 0 ||
      !Array.isArray(authority.requiredClaims ?? []) ||
      !(authority.requiredClaims ?? []).every(
        (claim) =>
          isNormalizedText(claim.claim) &&
          (typeof claim.value === "string"
            ? isNormalizedText(claim.value)
            : typeof claim.value === "boolean"),
      ) ||
      !hasValidEnterpriseMembershipSource(authority.membership)
    ) {
      return false;
    }
    return authority.tenantBinding.kind === "issuer"
      ? isNormalizedText(authority.tenantBinding.tenantId)
      : isNormalizedText(authority.tenantBinding.claim) &&
          isNormalizedText(authority.tenantBinding.value);
  });
}

export function createMemoryRegistrars(state: PluginRegistryState) {
  const { registry, registryParams, enterpriseIdentityProviderAuthorityRegistry, pushDiagnostic } =
    state;

  const rejectEnterpriseIdentityProvider = (record: PluginRecord, message: string): void => {
    pushDiagnostic({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message,
    });
    if (registryParams.enterpriseIdentityAuthorityStartup === true) {
      record.status = "error";
      record.error = message;
      record.failurePhase = "register";
      record.failedAt = new Date();
    }
  };

  const requireMemorySlot = (record: PluginRecord, surface: string): boolean => {
    if (!hasKind(record.kind, "memory")) {
      throw new Error(`only memory plugins can register a memory ${surface}`);
    }
    if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `dual-kind plugin not selected for memory slot; skipping memory ${surface} registration`,
      });
      return false;
    }
    return true;
  };

  const registerMemoryCapability = (
    record: PluginRecord,
    capability: Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0],
  ) => {
    if (requireMemorySlot(record, "capability")) {
      registry.memoryCapabilities.push({ pluginId: record.id, capability });
    }
  };

  const registerMemoryPromptSupplement = (
    record: PluginRecord,
    builder: Parameters<OpenClawPluginApi["registerMemoryPromptSupplement"]>[0],
  ) => {
    if (typeof builder !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "memory prompt supplement registration missing builder",
      });
      return;
    }
    registry.memoryPromptSupplements = registry.memoryPromptSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptSupplements.push({ pluginId: record.id, builder });
  };

  const registerMemoryPromptPreparation = (
    record: PluginRecord,
    prepare: Parameters<OpenClawPluginApi["registerMemoryPromptPreparation"]>[0],
  ) => {
    if (typeof prepare !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "memory prompt preparation registration missing prepare function",
      });
      return;
    }
    registry.memoryPromptPreparations = registry.memoryPromptPreparations.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptPreparations.push({ pluginId: record.id, prepare });
  };

  const registerMemoryCorpusSupplement = (
    record: PluginRecord,
    supplement: Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0],
  ) => {
    registry.memoryCorpusSupplements = registry.memoryCorpusSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryCorpusSupplements.push({ pluginId: record.id, supplement });
  };

  const registerMemoryEmbeddingProvider = (
    record: PluginRecord,
    adapter: Parameters<OpenClawPluginApi["registerMemoryEmbeddingProvider"]>[0],
  ) => {
    if (hasKind(record.kind, "memory")) {
      if (!requireMemorySlot(record, "embedding provider")) {
        return;
      }
    } else if (!(record.contracts?.memoryEmbeddingProviders ?? []).includes(adapter.id)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: ${adapter.id}`,
      });
      return;
    }
    const existing = registry.memoryEmbeddingProviders.find(
      (entry) => entry.provider.id === adapter.id,
    );
    if (existing) {
      const ownerDetail = existing.pluginId ? ` (owner: ${existing.pluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `memory embedding provider already registered: ${adapter.id}${ownerDetail}`,
      });
      return;
    }
    registry.memoryEmbeddingProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: adapter,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerEnterpriseIdentityProvider = (
    record: PluginRecord,
    provider: Parameters<OpenClawPluginApi["registerEnterpriseIdentityProvider"]>[0],
  ) => {
    if (enterpriseIdentityProviderAuthorityRegistry.isSealed()) {
      const existing = registry.enterpriseIdentityProviders.find(
        (entry) =>
          entry.pluginId === record.id &&
          entry.provider.providerPrefix === provider?.providerPrefix,
      );
      if (existing) {
        // A normal plugin reload replays the already-published authority. It
        // is not a new registration and cannot replace its sealed snapshot.
        return;
      }
      rejectEnterpriseIdentityProvider(
        record,
        "enterprise identity provider registry is sealed after startup",
      );
      return;
    }
    const providerPrefix = provider?.providerPrefix;
    if (
      typeof providerPrefix !== "string" ||
      !providerPrefix ||
      providerPrefix.trim() !== providerPrefix
    ) {
      rejectEnterpriseIdentityProvider(
        record,
        "enterprise identity provider registration missing a normalized providerPrefix",
      );
      return;
    }
    if (!(record.contracts?.enterpriseIdentityProviders ?? []).includes(providerPrefix)) {
      rejectEnterpriseIdentityProvider(
        record,
        `plugin must declare contracts.enterpriseIdentityProviders for provider: ${providerPrefix}`,
      );
      return;
    }
    if (!enterpriseIdentityProviderAuthorityRegistry.operatorAllowlist.has(providerPrefix)) {
      rejectEnterpriseIdentityProvider(
        record,
        `enterprise identity provider is not operator-allowlisted: ${providerPrefix}`,
      );
      return;
    }
    if (
      registry.enterpriseIdentityProviders.some(
        (entry) => entry.provider.providerPrefix === providerPrefix,
      )
    ) {
      rejectEnterpriseIdentityProvider(
        record,
        `enterprise identity provider already registered: ${providerPrefix}`,
      );
      return;
    }
    if (!Array.isArray(provider.authorities) || provider.authorities.length === 0) {
      rejectEnterpriseIdentityProvider(
        record,
        `enterprise identity provider requires at least one issuer and tenant authority: ${providerPrefix}`,
      );
      return;
    }
    if (!hasValidEnterpriseAuthority(provider)) {
      rejectEnterpriseIdentityProvider(
        record,
        `enterprise identity provider has an invalid issuer or tenant authority: ${providerPrefix}`,
      );
      return;
    }
    const authorityKeys = new Set<string>();
    for (const authority of provider.authorities) {
      const authorityKey = `${authority.issuer}\u0000${authority.tenantId}`;
      if (authorityKeys.has(authorityKey)) {
        rejectEnterpriseIdentityProvider(
          record,
          `enterprise identity provider repeats issuer and tenant authority: ${providerPrefix}`,
        );
        return;
      }
      authorityKeys.add(authorityKey);
      const existing = registry.enterpriseIdentityProviders.find((entry) =>
        entry.provider.authorities.some(
          (existingAuthority) =>
            existingAuthority.issuer === authority.issuer &&
            existingAuthority.tenantId === authority.tenantId,
        ),
      );
      if (existing) {
        rejectEnterpriseIdentityProvider(
          record,
          `enterprise identity authority already registered: ${authority.issuer} (${authority.tenantId}) by ${existing.pluginId}`,
        );
        return;
      }
    }
    registry.enterpriseIdentityProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const createMemoryEnterpriseAccessAuditReporter = (
    record: PluginRecord,
  ): MemoryEnterpriseAccessAuditReporter | undefined => {
    // Unlike memory capability registration, this closure grants a durable
    // write authority. Only the explicitly selected slot owner may receive it.
    if (!hasKind(record.kind, "memory") || record.memorySlotSelected !== true) {
      return undefined;
    }
    return Object.freeze({
      recordRoleAccessDecisions: recordMemoryEnterpriseRoleAccessDecisions,
    });
  };

  return {
    registerMemoryCapability,
    registerMemoryPromptSupplement,
    registerMemoryPromptPreparation,
    registerMemoryCorpusSupplement,
    registerMemoryEmbeddingProvider,
    registerEnterpriseIdentityProvider,
    createMemoryEnterpriseAccessAuditReporter,
  };
}
