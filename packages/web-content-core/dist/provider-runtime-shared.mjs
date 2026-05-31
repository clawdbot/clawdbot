//#region packages/web-content-core/src/provider-runtime-shared.ts
const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:";
const LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX = "__env__:";
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
const ENV_SECRET_SHORTHAND_RE = /^\$([A-Z][A-Z0-9_]{0,127})$/;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeSecretInputString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeSecretInput(value) {
	if (typeof value !== "string") return "";
	const collapsed = value.replace(/[\r\n\u2028\u2029]+/g, "");
	let latin1Only = "";
	for (const char of collapsed) {
		const codePoint = char.codePointAt(0);
		if (typeof codePoint === "number" && codePoint <= 255) latin1Only += char;
	}
	return latin1Only.trim();
}
function isSecretRef(value) {
	if (!isRecord(value)) return false;
	if (Object.keys(value).length !== 3) return false;
	return (value.source === "env" || value.source === "file" || value.source === "exec") && typeof value.provider === "string" && value.provider.trim().length > 0 && typeof value.id === "string" && value.id.trim().length > 0;
}
function coerceSecretRef(value) {
	if (isSecretRef(value)) return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		const legacyPrefix = trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX) ? LEGACY_SECRETREF_ENV_MARKER_PREFIX : trimmed.startsWith(LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX) ? LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX : void 0;
		if (legacyPrefix) {
			const id = trimmed.slice(legacyPrefix.length);
			return ENV_SECRET_REF_ID_RE.test(id) ? {
				source: "env",
				provider: DEFAULT_SECRET_PROVIDER_ALIAS,
				id
			} : null;
		}
		const match = ENV_SECRET_TEMPLATE_RE.exec(trimmed) ?? ENV_SECRET_SHORTHAND_RE.exec(trimmed);
		return match ? {
			source: "env",
			provider: DEFAULT_SECRET_PROVIDER_ALIAS,
			id: match[1]
		} : null;
	}
	if (isRecord(value) && (value.source === "env" || value.source === "file" || value.source === "exec") && typeof value.id === "string" && value.id.trim().length > 0 && value.provider === void 0) return {
		source: value.source,
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id: value.id
	};
	return null;
}
function resolveWebProviderConfig(cfg, kind) {
	const webConfig = cfg?.tools?.web;
	if (!webConfig || typeof webConfig !== "object") return;
	const toolConfig = webConfig[kind];
	if (!toolConfig || typeof toolConfig !== "object") return;
	return toolConfig;
}
function readWebProviderEnvValue(envVars, processEnv = process.env) {
	for (const envVar of envVars) {
		const value = normalizeSecretInput(processEnv[envVar]);
		if (value) return value;
	}
}
function providerRequiresCredential(provider) {
	return provider.requiresCredential !== false;
}
function hasWebProviderEntryCredential(params) {
	if (!providerRequiresCredential(params.provider)) return true;
	const rawValue = params.resolveRawValue({
		provider: params.provider,
		config: params.config,
		toolConfig: params.toolConfig
	});
	const configuredRef = coerceSecretRef(rawValue);
	if (configuredRef && configuredRef.source !== "env") return true;
	if (normalizeSecretInput(normalizeSecretInputString(rawValue))) return true;
	if (params.provider.authProviderId && params.resolveProviderAuthValue?.(params.provider.authProviderId)) return true;
	if (params.resolveEnvValue({
		provider: params.provider,
		configuredEnvVarId: configuredRef?.source === "env" ? configuredRef.id : void 0
	})) return true;
	const fallbackRawValue = params.resolveFallbackRawValue?.({
		provider: params.provider,
		config: params.config,
		toolConfig: params.toolConfig
	});
	const fallbackRef = coerceSecretRef(fallbackRawValue);
	if (fallbackRef && fallbackRef.source !== "env") return true;
	if (normalizeSecretInput(normalizeSecretInputString(fallbackRawValue))) return true;
	return Boolean(fallbackRef?.source === "env" ? params.resolveEnvValue({
		provider: params.provider,
		configuredEnvVarId: fallbackRef.id
	}) : void 0);
}
function resolveWebProviderDefinition(params) {
	if (!params.resolveEnabled({
		toolConfig: params.toolConfig,
		sandboxed: params.sandboxed
	})) return null;
	const providers = params.providers.filter(Boolean);
	if (providers.length === 0) return null;
	const autoProviderId = params.resolveAutoProviderId({
		config: params.config,
		toolConfig: params.toolConfig,
		providers
	});
	const providerId = params.providerId ?? params.runtimeMetadata?.selectedProvider ?? autoProviderId;
	if (!providerId) return null;
	const provider = providers.find((entry) => entry.id === providerId) ?? providers.find((entry) => entry.id === params.resolveFallbackProviderId?.({
		config: params.config,
		toolConfig: params.toolConfig,
		providers,
		providerId
	}));
	if (!provider) return null;
	const definition = params.createTool({
		provider,
		config: params.config,
		toolConfig: params.toolConfig,
		runtimeMetadata: params.runtimeMetadata
	});
	if (!definition) return null;
	return {
		provider,
		definition
	};
}
//#endregion
export { hasWebProviderEntryCredential, providerRequiresCredential, readWebProviderEnvValue, resolveWebProviderConfig, resolveWebProviderDefinition };
