// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag setup-only or tool runtime surfaces into lightweight plugin loads.
export { zalouserPlugin } from "./src/channel.js";
