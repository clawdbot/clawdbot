/** Runtime media-understanding dependencies used by ACP reply dispatch. */
export { applyMediaUnderstanding } from "../../media-understanding/apply.js";
export { MediaAttachmentCache } from "../../media-understanding/attachments.js";
export { normalizeAttachments } from "../../media-understanding/attachments.normalize.js";
export { isMediaUnderstandingSkipError } from "../../../packages/media-understanding-common/src/errors.js";
export { resolveMediaAttachmentLocalRoots } from "../../media-understanding/runner.js";
