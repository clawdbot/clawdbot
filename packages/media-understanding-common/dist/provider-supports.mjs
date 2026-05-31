//#region packages/media-understanding-common/src/provider-supports.ts
function providerSupportsCapability(provider, capability) {
	if (!provider) return false;
	if (capability === "audio") return Boolean(provider.transcribeAudio);
	if (capability === "image") return Boolean(provider.describeImage);
	return Boolean(provider.describeVideo);
}
//#endregion
export { providerSupportsCapability };
