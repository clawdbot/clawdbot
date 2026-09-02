// Lazy heartbeat runtime facade keeps tests from importing the full auto-reply
// runtime unless the runner path needs it.
export { getReplyFromConfig } from "../auto-reply/reply.js";
