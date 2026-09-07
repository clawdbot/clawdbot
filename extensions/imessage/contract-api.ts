// Imessage API module exposes the plugin public contract.
export {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots as resolveInboundAttachmentRoots,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots as resolveRemoteInboundAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "./media-contract-api.js";
