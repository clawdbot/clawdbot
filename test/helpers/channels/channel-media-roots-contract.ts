import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type IMessageContractSurface = {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS: string[];
  resolveIMessageAttachmentRoots: (params: unknown) => string[];
  resolveIMessageRemoteAttachmentRoots: (params: unknown) => string[];
};

const {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} = (await import(
  resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "imessage",
    artifactBasename: "contract-api.js",
  })
)) as IMessageContractSurface;

export {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
};
