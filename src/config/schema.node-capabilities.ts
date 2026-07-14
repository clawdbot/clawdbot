export const NODE_CAPABILITY_FIELD_HELP: Record<string, string> = {
  "gateway.nodes.pluginTools":
    "Controls whether paired nodes may publish agent-visible plugin tool descriptors.",
  "gateway.nodes.pluginTools.enabled":
    "Accept agent-visible plugin tool descriptors published by paired nodes (default: true). Set false to ignore and remove all node-published plugin tools.",
  "gateway.nodes.skills": "Controls whether paired nodes may publish agent-visible skills.",
  "gateway.nodes.skills.enabled":
    "Accept skills published by paired nodes while they are connected (default: true). Set false to ignore node-published skills.",
};

export const NODE_CAPABILITY_FIELD_LABELS: Record<string, string> = {
  "gateway.nodes.pluginTools": "Gateway Node Plugin Tools",
  "gateway.nodes.pluginTools.enabled": "Gateway Node Plugin Tools Enabled",
  "gateway.nodes.skills": "Gateway Node Skills",
  "gateway.nodes.skills.enabled": "Gateway Node Skills Enabled",
  "gateway.nodes.allowCommands": "Gateway Node Allowlist (Extra Commands)",
};
