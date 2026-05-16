const ADMIN_HTTP_RPC_ALLOWED_METHOD_GROUPS = {
  gateway: [
    "health",
    "status",
    "logs.tail",
    "usage.status",
    "usage.cost",
    "gateway.restart.request",
  ],
  discovery: ["commands.list"],
  config: [
    "config.get",
    "config.schema",
    "config.schema.lookup",
    "config.set",
    "config.patch",
    "config.apply",
  ],
  channels: ["channels.status", "channels.start", "channels.stop", "channels.logout"],
  models: ["models.list", "models.authStatus"],
  agents: ["agents.list", "agents.create", "agents.update", "agents.delete"],
  approvals: [
    "exec.approvals.get",
    "exec.approvals.set",
    "exec.approvals.node.get",
    "exec.approvals.node.set",
  ],
  cron: [
    "cron.status",
    "cron.list",
    "cron.get",
    "cron.runs",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
  ],
  devices: ["device.pair.list", "device.pair.approve", "device.pair.reject", "device.pair.remove"],
  nodes: [
    "node.list",
    "node.describe",
    "node.pair.list",
    "node.pair.approve",
    "node.pair.reject",
    "node.pair.remove",
    "node.rename",
  ],
  tasks: ["tasks.list", "tasks.get", "tasks.cancel"],
  diagnostics: ["doctor.memory.status", "update.status"],
} as const satisfies Record<string, readonly string[]>;

const ADMIN_HTTP_RPC_ALLOWED_METHODS: ReadonlySet<string> = new Set(
  Object.values(ADMIN_HTTP_RPC_ALLOWED_METHOD_GROUPS).flat(),
);

export function isAdminHttpRpcAllowedMethod(method: string): boolean {
  return ADMIN_HTTP_RPC_ALLOWED_METHODS.has(method);
}

export function listAdminHttpRpcAllowedMethods(): string[] {
  return Array.from(ADMIN_HTTP_RPC_ALLOWED_METHODS);
}
