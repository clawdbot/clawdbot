export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export {
  resolveThreadBindingLifecycle,
  type ThreadBindingLifecycleRecord,
} from "../shared/thread-binding-lifecycle.js";
export {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
