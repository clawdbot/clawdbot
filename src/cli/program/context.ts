import { listChannelPlugins } from "../../channels/plugins/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging.js";
import { loadClawdbotPlugins } from "../../plugins/loader.js";
import { VERSION } from "../../version.js";

export type ProgramContext = {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
};

const log = createSubsystemLogger("plugins");

function primePluginRegistry() {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  loadClawdbotPlugins({
    config,
    workspaceDir,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
      debug: (msg) => log.debug(msg),
    },
  });
}

export function createProgramContext(): ProgramContext {
  primePluginRegistry();
  const channelOptions = listChannelPlugins().map((plugin) => plugin.id);
  return {
    programVersion: VERSION,
    channelOptions,
    messageChannelOptions: channelOptions.join("|"),
    agentChannelOptions: ["last", ...channelOptions].join("|"),
  };
}
