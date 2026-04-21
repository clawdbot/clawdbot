// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag setup-only BlueBubbles surfaces into lightweight channel plugin loads.
export { bluebubblesPlugin } from "./src/channel.js";
