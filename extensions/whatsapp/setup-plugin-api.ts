// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader WhatsApp channel plugin surface.
export { whatsappSetupPlugin } from "./src/channel.setup.js";
