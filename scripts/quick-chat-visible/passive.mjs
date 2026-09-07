export const OPERATOR_PASSIVE_METHODS = ['system-event', 'voicewake.get', 'node.pair.list', 'device.pair.list', 'config.get', 'exec.approval.list'];
export const NODE_METHODS = ['node.event', 'node.pluginTools.update', 'node.skills.update', 'node.runnerInventory.update'];

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function exactKeys(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  requireValue(Object.keys(value).every(key => keys.includes(key)), 'Unsupported input field');
}

function nonempty(value, maximum = Infinity) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function enumArray(value, choices) {
  return Array.isArray(value) && value.every(item => choices.includes(item)) && new Set(value).size === value.length;
}

export function validateComputerUse(value) {
  exactKeys(value, ['contractVersion', 'provider', 'actions', 'targets', 'deliveryModes', 'observations', 'features']);
  requireValue(value.contractVersion === 2, 'Unsupported computer-use contract');
  exactKeys(value.provider, ['id', 'label', 'generation']);
  requireValue(nonempty(value.provider.id, 128) && nonempty(value.provider.label, 256) && nonempty(value.provider.generation, 256), 'Invalid computer-use provider');
  const actions = ['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'wait', 'list_apps', 'list_windows', 'get_accessibility_tree', 'get_cursor_position', 'get_window_state', 'launch_app', 'kill_app', 'bring_to_front', 'set_value', 'zoom', 'get_browser_state', 'browser_prepare', 'browser_navigate', 'browser_click', 'browser_type', 'browser_dialog', 'browser_set_input_files', 'browser_download', 'browser_pointer', 'escalate_scope', 'get_recording_state', 'start_recording', 'stop_recording', 'replay_trajectory', 'invoke_menu'];
  for (const [field, choices] of [['actions', actions], ['targets', ['screen', 'window', 'element', 'browser']], ['deliveryModes', ['background', 'foreground']], ['observations', ['image', 'accessibility', 'browser']]]) {
    requireValue(enumArray(value[field], choices), `Invalid computer-use ${field}`);
  }
  exactKeys(value.features, ['recording', 'agentCursor', 'multiDisplay']);
  requireValue(['recording', 'agentCursor', 'multiDisplay'].every(field => typeof value.features[field] === 'boolean'), 'Invalid computer-use features');
}

function validatePresence(params) {
  const textFields = ['text', 'instanceId', 'host', 'ip', 'mode', 'version', 'platform', 'deviceFamily', 'reason'];
  exactKeys(params, [...textFields, 'modelIdentifier', 'lastInputSeconds', 'tags']);
  requireValue(textFields.every(field => nonempty(params[field])), 'Invalid passive presence fields');
  requireValue(params.text.startsWith('Node:') && params.deviceFamily === 'Mac', 'Only Mac passive presence is supported');
  requireValue(params.modelIdentifier === undefined || nonempty(params.modelIdentifier), 'Invalid presence model identifier');
  requireValue(params.lastInputSeconds === 2592000 && Array.isArray(params.tags) && params.tags.length === 1 && params.tags[0] === 'system-presence-clear-last-input', 'Passive presence must clear exact input activity');
}

function validateTools(params) {
  exactKeys(params, ['tools']);
  requireValue(Array.isArray(params.tools), 'Invalid plugin tool inventory');
  for (const tool of params.tools) {
    exactKeys(tool, ['pluginId', 'name', 'description', 'parameters', 'command', 'mcp']);
    requireValue(nonempty(tool.pluginId) && nonempty(tool.description) && typeof tool.name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name), 'Invalid plugin tool descriptor');
    if (tool.parameters !== undefined) requireValue(tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters), 'Invalid tool parameters schema');
    requireValue(tool.command === undefined || nonempty(tool.command), 'Invalid tool command metadata');
    if (tool.mcp !== undefined) {
      exactKeys(tool.mcp, ['server', 'tool']);
      requireValue(nonempty(tool.mcp.server) && nonempty(tool.mcp.tool), 'Invalid MCP tool metadata');
    }
  }
}

function validateSkills(params) {
  exactKeys(params, ['skills']);
  requireValue(Array.isArray(params.skills) && params.skills.length <= 64, 'Invalid skill inventory');
  for (const skill of params.skills) {
    exactKeys(skill, ['name', 'description', 'content']);
    requireValue(typeof skill.name === 'string' && /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(skill.name) && nonempty(skill.description, 1024) && nonempty(skill.content, 65536), 'Invalid skill descriptor');
  }
}

function validateRunner(params) {
  exactKeys(params, ['protocolFeatures', 'workerHost']);
  requireValue(Array.isArray(params.protocolFeatures) && params.protocolFeatures.length === 1 && params.protocolFeatures[0] === 'node-worker-supervisor-v6', 'Only the current passive runner declaration is supported');
  const host = params.workerHost;
  exactKeys(host, ['enabled', 'capacity', 'bundlePrewarm', 'bundleRetention', 'bundleStatus', 'portalStream', 'environmentSession']);
  requireValue(typeof host.enabled === 'boolean', 'Invalid worker-host declaration');
  if (!host.enabled) {
    exactKeys(host, ['enabled']);
    return;
  }
  exactKeys(host.capacity, ['total', 'available']);
  requireValue(integer(host.capacity.total, 1, 1024) && integer(host.capacity.available, 0, host.capacity.total), 'Invalid declared worker capacity');
  for (const field of ['bundlePrewarm', 'bundleRetention', 'bundleStatus', 'portalStream', 'environmentSession']) requireValue(host[field] === undefined || host[field] === 1, 'Invalid runner feature version');
  requireValue(host.bundleStatus === undefined || host.bundleRetention === 1, 'Bundle status requires retention');
}

function validateHostStats(payload) {
  exactKeys(payload, ['cpuCount', 'loadAverage', 'memoryTotalBytes', 'memoryFreeBytes', 'diskTotalBytes', 'diskAvailableBytes']);
  requireValue(integer(payload.cpuCount, 1, 4096) && integer(payload.memoryTotalBytes, 0) && integer(payload.memoryFreeBytes, 0, payload.memoryTotalBytes), 'Invalid host memory or CPU stats');
  requireValue(payload.loadAverage === undefined || (Array.isArray(payload.loadAverage) && payload.loadAverage.length === 3 && payload.loadAverage.every(value => Number.isFinite(value) && value >= 0 && value <= 100000)), 'Invalid host load average');
  requireValue(payload.diskTotalBytes === undefined ? payload.diskAvailableBytes === undefined : integer(payload.diskTotalBytes, 0) && integer(payload.diskAvailableBytes, 0, payload.diskTotalBytes), 'Invalid or unpaired disk stats');
}

function validateActivity(payload) {
  if (payload?.action === 'clear') {
    exactKeys(payload, ['action']);
    return;
  }
  exactKeys(payload, ['idleSeconds', 'saturated']);
  requireValue(integer(payload.idleSeconds, 0, 2592000) && (payload.saturated === undefined || typeof payload.saturated === 'boolean'), 'Invalid node presence activity');
}

export function createPassiveState({ scope, broadcast, record }) {
  const presence = new Map();
  let presenceVersion = 0;
  const snapshot = () => ({ presence: [...presence.values()], stateVersion: { presence: presenceVersion, health: 0 } });
  const respond = (connection, method, params) => {
    const nodeId = connection.deviceId;
    switch (method) {
      case 'exec.approval.list':
        exactKeys(params, []);
        return [];
      case 'voicewake.get':
        exactKeys(params, []);
        return { triggers: [] };
      case 'node.pair.list':
      case 'device.pair.list':
        exactKeys(params, []);
        return { pending: [], paired: [] };
      case 'config.get':
        exactKeys(params, []);
        return { config: { session: { scope: scope === 'global' ? 'global' : 'per-sender' } } };
      case 'system-event': {
        validatePresence(params);
        const { lastInputSeconds, ...entry } = params;
        presence.set(connection.id, { ...entry, ts: Date.now() });
        presenceVersion += 1;
        broadcast('presence', { presence: [...presence.values()] }, { presence: presenceVersion, health: 0 });
        record('passive-presence', { connectionId: connection.id, presenceVersion, exactActivityCleared: true });
        return { ok: true };
      }
      case 'node.pluginTools.update':
        validateTools(params);
        connection.passive.tools = params.tools;
        record('passive-inventory', { connectionId: connection.id, nodeId, method, declaration: params });
        return { nodeId, tools: params.tools };
      case 'node.skills.update':
        validateSkills(params);
        connection.passive.skills = params.skills;
        record('passive-inventory', { connectionId: connection.id, nodeId, method, declaration: params });
        return { nodeId, skills: params.skills };
      case 'node.runnerInventory.update':
        validateRunner(params);
        connection.passive.runnerInventory = params;
        record('passive-inventory', { connectionId: connection.id, nodeId, method, declaration: params });
        return { nodeId };
      case 'node.event': {
        exactKeys(params, ['event', 'payload', 'payloadJSON']);
        requireValue(['node.host.stats', 'node.presence.activity'].includes(params.event), 'Unsupported passive node event');
        requireValue(params.payloadJSON === undefined || typeof params.payloadJSON === 'string', 'Invalid node event JSON');
        const payload = params.payloadJSON === undefined ? params.payload : JSON.parse(params.payloadJSON);
        let reason;
        if (params.event === 'node.host.stats') {
          validateHostStats(payload);
          const hostStats = { ...payload, updatedAtMs: Date.now() };
          connection.passive.hostStats = hostStats;
          broadcast('node.hostStats', { nodeId, hostStats });
          reason = 'updated';
        } else {
          validateActivity(payload);
          if (payload.action === 'clear') {
            reason = connection.passive.activity ? 'cleared' : 'already_clear';
            delete connection.passive.activity;
            if (reason === 'cleared') broadcast('node.presence', { nodeId, lastActiveAtMs: null, presenceUpdatedAtMs: null });
          } else if (connection.permissions.accessibility !== true) {
            record('passive-permission-denied', { connectionId: connection.id, nodeId, event: params.event });
            return { ok: true, event: params.event, handled: false, reason: 'permission_required' };
          } else {
            const now = Date.now();
            const previous = connection.passive.activity?.lastActiveAtMs;
            const reported = Math.max(0, now - payload.idleSeconds * 1000);
            const lastActiveAtMs = payload.saturated === true && previous !== undefined ? previous : Math.max(previous ?? 0, reported);
            connection.passive.activity = { lastActiveAtMs, presenceUpdatedAtMs: now };
            broadcast('node.presence', { nodeId, ...connection.passive.activity });
            reason = 'updated';
          }
        }
        record('passive-node-event', { connectionId: connection.id, nodeId, event: params.event, reason });
        return { ok: true, event: params.event, handled: true, reason };
      }
      default: throw new Error(`Unsupported passive method: ${method}`);
    }
  };
  return { snapshot, respond };
}
