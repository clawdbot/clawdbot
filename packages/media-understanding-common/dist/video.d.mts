//#region packages/media-understanding-common/src/video.d.ts
declare function estimateBase64Size(bytes: number): number;
declare function resolveVideoMaxBase64Bytes(maxBytes: number): number;
//#endregion
export { estimateBase64Size, resolveVideoMaxBase64Bytes };