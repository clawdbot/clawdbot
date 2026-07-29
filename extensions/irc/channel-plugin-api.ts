// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag IRC runtime/send/monitor surfaces into lightweight plugin loads.
export { ircPlugin } from "./src/channel.js";
