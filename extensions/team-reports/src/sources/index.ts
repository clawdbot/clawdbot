// Source factories. The report core imports only this barrel; implementations live in
// ./github and ./discord (sources lane). Keep signatures stable.
export { createGithubSource } from "./github/index.js";
export { createDiscordSource } from "./discord/index.js";
