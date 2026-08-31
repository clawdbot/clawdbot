/**
 * Dependency-light channel streaming config readers.
 *
 * Doctor contract closures (e.g. Slack's streaming compat rules) need these
 * pure config helpers; the broad `channel-outbound` barrel also value-loads
 * the reply-pipeline/channel-registry graph, which doctor enumeration must
 * not cold-load, and `channel-streaming` is a deprecated compat barrel.
 */
export {
  getChannelStreamingConfigObject,
  resolveChannelStreamingNativeTransport,
} from "../channels/streaming-config-readers.js";
