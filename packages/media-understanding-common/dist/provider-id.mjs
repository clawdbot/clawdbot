//#region packages/media-understanding-common/src/provider-id.ts
function normalizeProviderId(provider) {
	return provider.trim().toLowerCase();
}
function normalizeMediaProviderId(id) {
	const normalized = normalizeProviderId(id);
	if (normalized === "gemini") return "google";
	if (normalized === "minimax-cn") return "minimax";
	if (normalized === "minimax-portal-cn") return "minimax-portal";
	return normalized;
}
function normalizeMediaExecutionProviderId(id) {
	const normalized = normalizeProviderId(id);
	if (normalized === "minimax-cn" || normalized === "minimax-portal-cn") return normalized;
	return normalizeMediaProviderId(normalized);
}
//#endregion
export { normalizeMediaExecutionProviderId, normalizeMediaProviderId };
