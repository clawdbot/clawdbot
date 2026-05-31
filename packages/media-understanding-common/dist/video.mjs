import { DEFAULT_VIDEO_MAX_BASE64_BYTES } from "./defaults.mjs";
//#region packages/media-understanding-common/src/video.ts
function estimateBase64Size(bytes) {
	return Math.ceil(bytes / 3) * 4;
}
function resolveVideoMaxBase64Bytes(maxBytes) {
	const expanded = Math.floor(maxBytes * (4 / 3));
	return Math.min(expanded, DEFAULT_VIDEO_MAX_BASE64_BYTES);
}
//#endregion
export { estimateBase64Size, resolveVideoMaxBase64Bytes };
