import { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.mjs";

//#region packages/media-understanding-common/src/provider-supports.d.ts
declare function providerSupportsCapability(provider: MediaUnderstandingProvider | undefined, capability: MediaUnderstandingCapability): boolean;
//#endregion
export { providerSupportsCapability };