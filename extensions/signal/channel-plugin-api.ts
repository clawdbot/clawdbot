// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag setup-only Signal surfaces into lightweight channel plugin loads.
export { signalPlugin } from "./src/channel.js";
