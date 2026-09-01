// Keep bundled channel bootstrap loads narrow so lightweight channel entry
// loads do not import setup-only surfaces.
export { whatsappPlugin } from "./src/channel.js";
