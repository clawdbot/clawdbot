// Imessage API module exposes the plugin public contract.
export {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageAttachmentRoots as resolveInboundAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots as resolveRemoteInboundAttachmentRoots,
} from "./src/media-contract.js";
