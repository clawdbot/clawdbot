// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag the broad Telegram API barrel into lightweight plugin loads.
export { telegramPlugin } from "./src/channel.js";
export { telegramSetupPlugin } from "./src/channel.setup.js";
