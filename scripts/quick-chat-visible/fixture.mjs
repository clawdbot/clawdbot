import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPassiveState, exactKeys, NODE_METHODS, OPERATOR_PASSIVE_METHODS, requireValue, validateComputerUse } from './passive.mjs';

export const SOURCE = 'ff58c1c42fd6353974b2da8b9ba7384248b0c634';
export const SCOPES = ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.questions', 'operator.pairing'];
const HOST = '127.0.0.1';
const PROTOCOL = 4;
const MAX_PAYLOAD = 1024 * 1024;
const SYNTHETIC_STORE_PATH = '/synthetic/f27/session-store.sqlite';
const METHODS = ['health', 'last-heartbeat', 'users.prefs.get', 'agent.identity.get', 'agents.list', 'models.list', 'chat.metadata', 'sessions.list', 'sessions.patch', ...OPERATOR_PASSIVE_METHODS];
const EVENTS = ['tick', 'chat.metadata.changed', 'config.changed', 'presence', 'node.hostStats', 'node.presence'];
const CATALOG_METHODS = ['models.list', 'chat.metadata'];

function equalToken(actual, expected) {
  return typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function strings(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

export function loadWebSocket(packageRoot) {
  const require = createRequire(path.join(path.resolve(packageRoot), 'package.json'));
  const manifestPath = require.resolve('ws/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  requireValue(manifest.version === '8.21.3', `Expected existing ws 8.21.3, found ${manifest.version}`);
  return { implementation: require('ws'), manifestPath, version: manifest.version };
}

function signaturePayload(params) {
  return ['v2', params.device.id, params.client.id, params.client.mode, params.role, params.scopes.join(','), String(params.device.signedAt), params.auth.token, params.device.nonce].join('|');
}

function authenticate(params, connection, token) {
  exactKeys(params, ['minProtocol', 'maxProtocol', 'client', 'caps', 'commands', 'computerUse', 'pathEnv', 'permissions', 'role', 'scopes', 'device', 'auth', 'locale', 'userAgent']);
  requireValue(Number.isInteger(params.minProtocol) && Number.isInteger(params.maxProtocol) && params.minProtocol >= 1 && params.minProtocol <= PROTOCOL && params.maxProtocol >= PROTOCOL, 'Fixture requires negotiated protocol 4');
  exactKeys(params.client, ['id', 'displayName', 'version', 'buildId', 'platform', 'deviceFamily', 'modelIdentifier', 'timeZone', 'mode', 'instanceId']);
  requireValue(params.client.id === 'openclaw-macos' && ((params.client.mode === 'ui' && params.role === 'operator') || (params.client.mode === 'node' && params.role === 'node')), 'Only the synthetic Mac operator/ui and node/node routes are supported');
  requireValue(typeof params.client.version === 'string' && params.client.version.length > 0 && typeof params.client.platform === 'string' && params.client.platform.length > 0, 'Client version and platform are required');
  requireValue(Object.values(params.client).every(value => typeof value === 'string' && value.length > 0), 'Client fields must be nonempty strings');
  requireValue((params.client.buildId?.length ?? 0) <= 96 && (params.client.timeZone?.length ?? 0) <= 64, 'Client metadata exceeds the protocol bounds');
  for (const field of ['caps', 'commands']) requireValue(params[field] === undefined || strings(params[field]), `Invalid ${field}`);
  for (const field of ['locale', 'userAgent']) requireValue(params[field] === undefined || typeof params[field] === 'string', `Invalid ${field}`);
  if (params.permissions !== undefined) {
    requireValue(params.permissions && typeof params.permissions === 'object' && !Array.isArray(params.permissions) && Object.entries(params.permissions).every(([key, value]) => key.length > 0 && typeof value === 'boolean'), 'Invalid permissions');
  }
  requireValue(Array.isArray(params.scopes) && (params.role === 'node' ? params.scopes.length === 0 : params.scopes.length > 0 && params.scopes.every(scope => SCOPES.includes(scope)) && new Set(params.scopes).size === params.scopes.length), 'Unsupported role scope grant');
  requireValue(params.role === 'node' || (params.pathEnv === undefined && params.computerUse === undefined), 'Node-only connect declarations');
  requireValue(params.pathEnv === undefined || (typeof params.pathEnv === 'string' && params.pathEnv.length > 0), 'Invalid declared node path');
  if (params.computerUse !== undefined) validateComputerUse(params.computerUse);
  exactKeys(params.auth, ['token']);
  requireValue(equalToken(params.auth.token, token), 'Synthetic Gateway token rejected');
  exactKeys(params.device, ['id', 'publicKey', 'signature', 'signedAt', 'nonce']);
  requireValue(Number.isInteger(params.device.signedAt) && params.device.signedAt >= 0 && Math.abs(Date.now() - params.device.signedAt) <= 120000, 'Device signature expired');
  requireValue(params.device.nonce === connection.nonce, 'Device nonce mismatch');
  const publicBytes = Buffer.from(params.device.publicKey, 'base64url');
  const signature = Buffer.from(params.device.signature, 'base64url');
  requireValue(publicBytes.length === 32 && publicBytes.toString('base64url') === params.device.publicKey && signature.length === 64 && signature.toString('base64url') === params.device.signature, 'Invalid canonical device proof encoding');
  requireValue(createHash('sha256').update(publicBytes).digest('hex') === params.device.id, 'Device identity mismatch');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes]), format: 'der', type: 'spki' });
  requireValue(verify(null, Buffer.from(signaturePayload(params)), publicKey, signature), 'Device signature rejected');
}

export async function startFixture({ packageRoot, output, gatewayPort = 0, controlPort = 0, durationSeconds = 900, scope = 'per-agent', capability = 'supported' }) {
  requireValue(path.isAbsolute(output), 'Output must be an absolute fresh directory');
  requireValue(['per-agent', 'global'].includes(scope), 'Invalid scope');
  requireValue(['supported', 'unsupported', 'absent'].includes(capability), 'Invalid capability mode');
  requireValue(Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 1800, 'Duration must be 1..1800 seconds');
  for (const port of [gatewayPort, controlPort]) requireValue(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid listening port');
  const dependency = loadWebSocket(packageRoot);
  const WebSocket = dependency.implementation;
  const runId = randomUUID();
  const startedAt = Date.now();
  const gatewayToken = `synthetic-f27-${randomBytes(24).toString('hex')}`;
  const controlToken = randomBytes(32).toString('hex');
  mkdirSync(output, { mode: 0o700 });
  const logPath = path.join(output, 'wire.jsonl');
  const log = openSync(logPath, 'wx', 0o600);
  let logOpen = true;
  let recordSequence = 0;
  const record = (event, fields = {}) => {
    if (logOpen) writeSync(log, `${JSON.stringify({ record: ++recordSequence, at: new Date().toISOString(), runId, event, ...fields })}\n`);
  };
  const connections = new Map();
  const currentNodes = new Map();
  const held = new Map();
  const faults = new Map();
  const scopedModels = new Map();
  const selectedModels = new Map([['a', 'choice-a'], ['b', 'choice-b']]);
  const sessionUpdatedAt = new Map([['a', startedAt], ['b', startedAt]]);
  let models = ['choice-a', 'choice-b'];
  let revision = 0;
  let connectionSequence = 0;
  let boundaryCount = 0;
  let stopping;
  let deadline;
  let tick;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const gateway = createServer((request, response) => {
    record('unsupported-http', { method: request.method, url: request.url });
    response.writeHead(404).end('Synthetic WebSocket fixture only');
  });
  const sockets = new Set();
  const websocketServer = new WebSocket.WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, closeTimeout: 1000 });
  const send = (connection, frame) => {
    const raw = JSON.stringify(frame);
    if (connection.socket.readyState !== WebSocket.OPEN) {
      record('undeliverable', { connectionId: connection.id, frame, reason: 'original socket is not open' });
      return false;
    }
    if (connection.socket.bufferedAmount + Buffer.byteLength(raw) > MAX_PAYLOAD) {
      record('undeliverable', { connectionId: connection.id, frame, reason: 'advertised buffered-byte limit exceeded' });
      connection.socket.close(1009, 'Fixture buffer limit');
      return false;
    }
    record('wire-out', { connectionId: connection.id, revision, raw, base64: Buffer.from(raw).toString('base64') });
    connection.socket.send(raw, error => {
      if (error) record('send-error', { connectionId: connection.id, message: error.message });
    });
    return true;
  };
  const refuse = (connection, id, message, close = false) => {
    send(connection, { type: 'res', id, ok: false, error: { code: 'INVALID_REQUEST', message } });
    if (close) connection.socket.close(1008, 'Synthetic fixture request refused');
  };
  const passive = createPassiveState({ scope, record, broadcast: (event, payload, stateVersion) => {
    for (const connection of connections.values()) if (connection.authenticated && connection.role === 'operator' && (connection.scopes.includes('operator.admin') || connection.scopes.includes('operator.read')) && connection.socket.readyState === WebSocket.OPEN) {
      send(connection, { type: 'event', event, payload, seq: ++connection.sequence, ...(stateVersion ? { stateVersion } : {}) });
    }
  } });
  const targetOf = params => params.sessionKey ?? params.key ?? params.search;
  const ownerOf = params => {
    const target = targetOf(params);
    const match = typeof target === 'string' ? /^agent:([^:]+):.+$/i.exec(target) : null;
    const agentId = match?.[1] ?? params.agentId ?? 'a';
    requireValue(['a', 'b'].includes(agentId), 'Unknown synthetic agent owner');
    return agentId;
  };
  const sessionRows = (params, now) => {
    const owner = ownerOf(params);
    const key = params.search ?? (scope === 'global' ? 'global' : `agent:${owner}:main`);
    const updatedAt = sessionUpdatedAt.get(owner);
    if (params.archived || (key === 'global' && params.includeGlobal === false) || (params.activeMinutes !== undefined && updatedAt < now - params.activeMinutes * 60000)) return [];
    return [{ key, kind: key === 'global' ? 'global' : 'direct', modelProvider: 'fixture', model: selectedModels.get(owner), thinkingLevel: 'low', updatedAt }];
  };
  const responseFor = (request, connection) => {
    const params = request.params === undefined ? {} : request.params;
    if (OPERATOR_PASSIVE_METHODS.includes(request.method) || NODE_METHODS.includes(request.method)) return { type: 'res', id: request.id, ok: true, payload: passive.respond(connection, request.method, params) };
    const fields = {
      health: ['timeout'],
      'last-heartbeat': [],
      'users.prefs.get': ['keys'],
      'agent.identity.get': ['agentId', 'sessionKey'],
      'agents.list': [],
      'models.list': ['agentId'],
      'chat.metadata': ['agentId', 'sessionKey'],
      'sessions.list': ['limit', 'search', 'archived', 'includeGlobal', 'includeUnknown', 'agentId', 'activeMinutes'],
      'sessions.patch': ['key', 'model', 'agentId'],
    }[request.method];
    requireValue(fields, `Unsupported synthetic fixture method: ${request.method}`);
    exactKeys(params, fields);
    for (const field of ['agentId', 'sessionKey', 'key', 'model', 'search']) requireValue(params[field] === undefined || (typeof params[field] === 'string' && params[field].length > 0), `Invalid ${field}`);
    for (const field of ['archived', 'includeGlobal', 'includeUnknown']) requireValue(params[field] === undefined || typeof params[field] === 'boolean', `Invalid ${field}`);
    requireValue(params.limit === undefined || (Number.isInteger(params.limit) && params.limit >= 1), 'Invalid list limit');
    requireValue(params.activeMinutes === undefined || (Number.isInteger(params.activeMinutes) && params.activeMinutes >= 1), 'Invalid activeMinutes');
    requireValue(params.timeout === undefined || (Number.isInteger(params.timeout) && params.timeout >= 0), 'Invalid health timeout');
    requireValue(params.keys === undefined || strings(params.keys), 'Invalid preference keys');
    const owner = ownerOf(params);
    const fault = faults.get(request.method);
    if (fault === 'rpc') return { type: 'res', id: request.id, ok: false, error: { code: 'UNAVAILABLE', message: 'Synthetic catalog publication failed' } };
    let payload;
    if (fault === 'decode') payload = { models: 'invalid synthetic catalog shape' };
    else switch (request.method) {
      case 'health': {
        const now = Date.now();
        const recent = sessionRows({}, now).map(row => ({ key: row.key, updatedAt: row.updatedAt, age: now - row.updatedAt }));
        payload = { ok: true, ts: now, durationMs: 0, channels: {}, channelOrder: [], channelLabels: {}, heartbeatSeconds: 0, sessions: { path: SYNTHETIC_STORE_PATH, count: recent.length, recent } };
        break;
      }
      case 'last-heartbeat': payload = null; break;
      case 'users.prefs.get': payload = { status: 'no_durable_identity' }; break;
      case 'agent.identity.get': payload = { agentId: owner, name: owner.toUpperCase() }; break;
      case 'agents.list': payload = { defaultId: 'a', mainKey: 'main', scope, agents: ['a', 'b'].map(agentId => ({ id: agentId, name: agentId.toUpperCase() })) }; break;
      case 'models.list': payload = { models: models.map(modelId => ({ id: modelId, name: modelId, provider: 'fixture', available: true })) }; break;
      case 'chat.metadata': {
        requireValue(typeof params.sessionKey === 'string' && params.sessionKey.length > 0, 'The F27 metadata contract requires sessionKey');
        const choices = scopedModels.get(JSON.stringify([owner, params.sessionKey])) ?? models;
        payload = { models: choices.map(modelId => ({ id: modelId, name: modelId, provider: 'fixture', available: true })) };
        break;
      }
      case 'sessions.list': {
        const now = Date.now();
        const sessions = sessionRows(params, now);
        payload = { ts: now, path: SYNTHETIC_STORE_PATH, count: sessions.length, defaults: { modelProvider: 'fixture', model: 'choice-a', contextTokens: 32000 }, sessions };
        break;
      }
      case 'sessions.patch': {
        requireValue(typeof params.key === 'string' && typeof params.model === 'string' && params.model.startsWith('fixture/'), 'Only an explicit synthetic fixture model patch is supported');
        payload = { key: params.key, entry: { modelProvider: 'fixture', model: params.model } };
        break;
      }
      default: throw new Error(`Unsupported synthetic fixture method: ${request.method}`);
    }
    return { type: 'res', id: request.id, ok: true, payload };
  };
  const settle = (connection, request, response) => {
    if (request.method === 'sessions.patch' && response.ok) {
      const owner = ownerOf(request.params);
      selectedModels.set(owner, request.params.model.slice('fixture/'.length));
      sessionUpdatedAt.set(owner, Date.now());
      record('patch-settled', { connectionId: connection.id, requestId: request.id, owner, target: targetOf(request.params), model: request.params.model });
    }
    send(connection, response);
  };
  gateway.on('upgrade', (request, socket, head) => {
    if (stopping || request.url !== '/' || request.headers.origin || request.headers.host !== `${HOST}:${gateway.address().port}` || websocketServer.clients.size >= 16 || connections.size >= 128) {
      record('upgrade-refused', { url: request.url, origin: request.headers.origin ?? null });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, client => websocketServer.emit('connection', client));
  });
  websocketServer.on('connection', socket => {
    const connection = { id: `connection-${++connectionSequence}`, socket, nonce: randomBytes(24).toString('hex'), authenticated: false, scopes: [], sequence: 0, requests: new Set(), hold: null };
    connections.set(connection.id, connection);
    const authDeadline = setTimeout(() => socket.close(1008, 'Connect deadline expired'), 10000);
    record('connection-open', { connectionId: connection.id });
    send(connection, { type: 'event', event: 'connect.challenge', payload: { nonce: connection.nonce, ts: Date.now() } });
    socket.on('message', (bytes, binary) => {
      record('wire-in', { connectionId: connection.id, binary, raw: bytes.toString('utf8'), base64: bytes.toString('base64') });
      let request;
      try {
        request = JSON.parse(bytes.toString('utf8'));
        exactKeys(request, ['type', 'id', 'method', 'params', 'traceparent']);
        requireValue(request.type === 'req' && typeof request.id === 'string' && request.id.length > 0 && typeof request.method === 'string', 'Invalid request envelope');
        requireValue(!connection.requests.has(request.id) && connection.requests.size < 10000, 'Duplicate request ID or per-connection request limit');
        connection.requests.add(request.id);
        if (!connection.authenticated) {
          requireValue(request.method === 'connect', 'Connect is required before requests');
          authenticate(request.params, connection, gatewayToken);
          clearTimeout(authDeadline);
          connection.authenticated = true;
          connection.scopes = [...request.params.scopes];
          connection.deviceId = request.params.device.id;
          connection.role = request.params.role;
          connection.client = request.params.client;
          connection.permissions = request.params.permissions ?? {};
          connection.passive = {};
          if (connection.role === 'node') {
            const previous = currentNodes.get(connection.deviceId);
            currentNodes.set(connection.deviceId, connection.id);
            record('node-owner-admitted', { nodeId: connection.deviceId, connectionId: connection.id, previousConnectionId: previous ?? null, declarations: { caps: request.params.caps, commands: request.params.commands, computerUse: request.params.computerUse, pathEnv: request.params.pathEnv, permissions: connection.permissions } });
          }
          const features = { methods: connection.role === 'node' ? NODE_METHODS : METHODS, events: connection.role === 'node' ? ['tick'] : EVENTS };
          if (connection.role === 'operator' && capability !== 'absent') features.capabilities = capability === 'supported' ? ['session-scoped-chat-metadata'] : [];
          send(connection, { type: 'res', id: request.id, ok: true, payload: { type: 'hello-ok', protocol: PROTOCOL, server: { version: '2026.9.2-fixture', connId: connection.id, bootId: runId }, features, snapshot: { ...passive.snapshot(), health: { ok: true }, uptimeMs: Date.now() - startedAt, sessionDefaults: { defaultAgentId: 'a', mainKey: 'main', mainSessionKey: scope === 'global' ? 'global' : 'agent:a:main', scope } }, auth: { role: connection.role, scopes: connection.scopes }, policy: { maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_PAYLOAD, tickIntervalMs: 30000 } } });
          record('authenticated', { connectionId: connection.id, deviceId: connection.deviceId, role: connection.role, client: connection.client, scopes: connection.scopes, permissions: connection.permissions, protocol: PROTOCOL });
          return;
        }
        requireValue(request.method !== 'connect', 'Connect cannot be repeated on an admitted socket');
        if (connection.role === 'node') {
          requireValue(NODE_METHODS.includes(request.method), 'Node role does not authorize this method');
          requireValue(currentNodes.get(connection.deviceId) === connection.id, 'Node publication owner is no longer current');
        } else {
          requireValue(METHODS.includes(request.method), `Unsupported synthetic operator method: ${request.method}`);
          const requiredScope = request.method === 'exec.approval.list' ? 'operator.approvals' : request.method === 'system-event' ? 'operator.admin' : ['node.pair.list', 'device.pair.list'].includes(request.method) ? 'operator.pairing' : request.method === 'sessions.patch' ? 'operator.write' : 'operator.read';
          requireValue(connection.scopes.includes('operator.admin') || connection.scopes.includes(requiredScope), 'Operator scope does not authorize this request');
        }
        const response = responseFor(request, connection);
        const hold = connection.hold;
        if (hold && hold.method === request.method && (hold.target === undefined || hold.target === targetOf(request.params ?? {}))) {
          requireValue(held.size < 32, 'Held-response limit reached');
          connection.hold = null;
          const heldId = `${connection.id}/${request.id}`;
          held.set(heldId, { connection, request, response, revision });
          record('response-held', { heldId, connectionId: connection.id, request, response, revision });
        } else settle(connection, request, response);
      } catch (error) {
        boundaryCount += 1;
        record('request-refused', { connectionId: connection.id, requestId: request?.id ?? null, method: request?.method ?? null, message: error.message });
        if (typeof request?.id === 'string') refuse(connection, request.id, error.message, !connection.authenticated);
        else socket.close(1008, 'Malformed fixture request');
      }
    });
    socket.on('error', error => record('socket-error', { connectionId: connection.id, message: error.message }));
    socket.on('close', (code, reason) => {
      clearTimeout(authDeadline);
      connection.hold = null;
      if (connection.role === 'node' && currentNodes.get(connection.deviceId) === connection.id) currentNodes.delete(connection.deviceId);
      record('connection-close', { connectionId: connection.id, code, reason: reason.toString() });
    });
  });
  const requireConnection = (id, requireOpen = true) => {
    const connection = connections.get(id);
    requireValue(connection?.authenticated && (!requireOpen || connection.socket.readyState === WebSocket.OPEN), 'No matching admitted connection');
    return connection;
  };
  const status = () => ({ runId, source: SOURCE, revision, scope, capability, boundaryCount, connections: [...connections.values()].map(connection => ({ id: connection.id, deviceId: connection.deviceId ?? null, authenticated: connection.authenticated, role: connection.role ?? null, client: connection.client ?? null, scopes: connection.scopes, permissions: connection.permissions ?? null, currentNode: connection.role === 'node' && currentNodes.get(connection.deviceId) === connection.id, passive: connection.passive ?? null, open: connection.socket.readyState === WebSocket.OPEN, sequence: connection.sequence, hold: connection.hold })), held: [...held].map(([id, item]) => ({ id, connectionId: item.connection.id, requestId: item.request.id, method: item.request.method, target: targetOf(item.request.params ?? {}) ?? null, revision: item.revision })), models, scopedModels: [...scopedModels], selectedModels: [...selectedModels], faults: [...faults], passive: passive.snapshot() });
  const control = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    try {
      requireValue(!stopping && !request.headers.origin && request.headers.host === `${HOST}:${control.address().port}` && equalToken(request.headers.authorization, `Bearer ${controlToken}`), 'Control authentication or origin rejected');
      if (request.method === 'GET' && request.url === '/status') {
        response.end(JSON.stringify(status()));
        return;
      }
      requireValue(request.method === 'POST' && request.headers['content-type'] === 'application/json', 'Use POST application/json');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        requireValue(bytes <= 65536, 'Control request exceeds 64 KiB');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      record('control', { path: request.url, body });
      let result;
      switch (request.url) {
        case '/catalog': {
          exactKeys(body, ['models', 'sessionKey', 'agentId']);
          requireValue(Array.isArray(body.models) && body.models.length <= 100 && body.models.every(model => typeof model === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(model)) && new Set(body.models).size === body.models.length, 'Expected distinct synthetic model IDs');
          if (body.sessionKey !== undefined || body.agentId !== undefined) {
            requireValue(typeof body.sessionKey === 'string' && body.sessionKey.length > 0 && body.sessionKey.length <= 256 && ['a', 'b'].includes(body.agentId), 'Scoped catalog needs sessionKey and agentId');
            requireValue(ownerOf(body) === body.agentId, 'Scoped catalog owner mismatch');
            scopedModels.set(JSON.stringify([body.agentId, body.sessionKey]), [...body.models]);
          } else models = [...body.models];
          result = { revision: ++revision };
          break;
        }
        case '/failure':
          exactKeys(body, ['method', 'kind']);
          requireValue(CATALOG_METHODS.includes(body.method) && [null, 'rpc', 'decode'].includes(body.kind), 'Expected catalog method and null/rpc/decode');
          if (body.kind === null) faults.delete(body.method);
          else faults.set(body.method, body.kind);
          result = { revision: ++revision };
          break;
        case '/publish': {
          exactKeys(body, ['connectionId', 'event', 'skip']);
          requireValue(['chat.metadata.changed', 'config.changed'].includes(body.event), 'Unsupported publication');
          const skip = body.skip ?? 0;
          requireValue(Number.isInteger(skip) && skip >= 0 && skip <= 10, 'Invalid explicit sequence gap');
          const connection = requireConnection(body.connectionId);
          requireValue(connection.role === 'operator', 'Catalog publication requires an operator destination');
          connection.sequence += 1 + skip;
          result = { connectionId: connection.id, sequence: connection.sequence, revision };
          send(connection, { type: 'event', event: body.event, payload: {}, seq: connection.sequence });
          break;
        }
        case '/hold': {
          exactKeys(body, ['connectionId', 'method', 'target']);
          requireValue(['models.list', 'chat.metadata', 'sessions.list', 'sessions.patch', 'agents.list'].includes(body.method), 'Unsupported held method');
          requireValue(body.target === undefined || typeof body.target === 'string', 'Invalid target');
          const connection = requireConnection(body.connectionId);
          requireValue(connection.role === 'operator', 'Catalog hold requires an operator destination');
          requireValue(!connection.hold, 'Connection already has an armed hold');
          connection.hold = { method: body.method, ...(body.target === undefined ? {} : { target: body.target }) };
          result = { armed: true, connectionId: connection.id };
          break;
        }
        case '/release': {
          exactKeys(body, ['heldId', 'outcome']);
          requireValue(['captured', 'rpc', 'decode'].includes(body.outcome), 'Invalid release outcome');
          const item = held.get(body.heldId);
          requireValue(item, 'Unknown held response');
          requireValue(body.outcome !== 'decode' || CATALOG_METHODS.includes(item.request.method), 'Decode fault only applies to catalog');
          held.delete(body.heldId);
          let frame = item.response;
          if (body.outcome === 'rpc') frame = { type: 'res', id: item.request.id, ok: false, error: { code: 'UNAVAILABLE', message: 'Synthetic delayed request failed' } };
          if (body.outcome === 'decode') frame = { type: 'res', id: item.request.id, ok: true, payload: { models: 'invalid synthetic catalog shape' } };
          settle(item.connection, item.request, frame);
          result = { released: body.heldId, originalConnectionId: item.connection.id, socketOpen: item.connection.socket.readyState === WebSocket.OPEN };
          record('response-released', { ...result, frame, capturedRevision: item.revision });
          break;
        }
        case '/disconnect': {
          exactKeys(body, ['connectionId']);
          const connection = requireConnection(body.connectionId);
          connection.socket.close(1012, 'Synthetic Gateway reconnect control');
          result = { disconnecting: connection.id };
          break;
        }
        case '/stop':
          exactKeys(body, []);
          response.end(JSON.stringify({ stopping: true, runId }));
          void stop('control');
          return;
        default: throw new Error('Unknown fixture control');
      }
      record('control-result', { path: request.url, result });
      response.end(JSON.stringify(result));
    } catch (error) {
      record('control-refused', { path: request.url, message: error.message });
      response.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });
  for (const server of [gateway, control]) {
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  }
  const stop = reason => {
    if (stopping) return stopping;
    stopping = (async () => {
      clearTimeout(deadline);
      clearInterval(tick);
      record('stopping', { reason, held: [...held.keys()] });
      for (const connection of connections.values()) if (connection.socket.readyState === WebSocket.OPEN) connection.socket.close(1001, 'Fixture finished');
      const force = setTimeout(() => {
        for (const client of websocketServer.clients) client.terminate();
        for (const socket of sockets) socket.destroy();
      }, 1000);
      await Promise.all([new Promise(resolve => websocketServer.close(resolve)), ...[gateway, control].map(server => new Promise(resolve => server.close(resolve)))]);
      clearTimeout(force);
      record('stopped', { reason, boundaryCount, held: [...held.keys()] });
      writeFileSync(path.join(output, 'stopped.json'), JSON.stringify({ runId, reason, boundaryCount, held: [...held.keys()] }, null, 2), { flag: 'wx', mode: 0o600 });
      logOpen = false;
      closeSync(log);
      finish();
    })();
    return stopping;
  };
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => { server.off('error', reject); resolve(); });
  });
  try {
    await listen(gateway, gatewayPort);
    await listen(control, controlPort);
    tick = setInterval(() => {
      for (const connection of connections.values()) if (connection.authenticated && connection.socket.readyState === WebSocket.OPEN) {
        send(connection, { type: 'event', event: 'tick', payload: { ts: Date.now() }, seq: ++connection.sequence });
      }
    }, 30000);
    deadline = setTimeout(() => { void stop('deadline'); }, durationSeconds * 1000);
    const ready = { source: SOURCE, synthetic: true, runId, protocol: PROTOCOL, gatewayUrl: `ws://${HOST}:${gateway.address().port}`, controlUrl: `http://${HOST}:${control.address().port}`, gatewayToken, controlToken, scope, capability, durationSeconds, wirePath: logPath, dependency: { name: 'ws', version: dependency.version, manifestPath: dependency.manifestPath } };
    record('ready', { ...ready, gatewayToken: '[synthetic token in private ready.json]', controlToken: '[private control token in ready.json]' });
    writeFileSync(path.join(output, 'ready.json'), JSON.stringify(ready, null, 2), { flag: 'wx', mode: 0o600 });
    return { ready, stop, done };
  } catch (error) {
    record('startup-failed', { message: error.message });
    await stop('startup-failed');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  const names = new Map([['--package-root', 'packageRoot'], ['--output', 'output'], ['--gateway-port', 'gatewayPort'], ['--control-port', 'controlPort'], ['--duration-seconds', 'durationSeconds'], ['--scope', 'scope'], ['--capability', 'capability']]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = names.get(process.argv[index]);
    requireValue(key && process.argv[index + 1] !== undefined && options[key] === undefined, 'Use the documented fixture argument pairs');
    options[key] = ['gatewayPort', 'controlPort', 'durationSeconds'].includes(key) ? Number(process.argv[index + 1]) : process.argv[index + 1];
  }
  requireValue(options.packageRoot && options.output, 'Required: --package-root <existing dependency root> --output <fresh absolute directory>');
  const fixture = await startFixture(options);
  const onInterrupt = () => { void fixture.stop('SIGINT'); };
  const onTerminate = () => { void fixture.stop('SIGTERM'); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  process.stdout.write(`${JSON.stringify({ readyFile: path.join(options.output, 'ready.json'), source: SOURCE })}\n`);
  await fixture.done;
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
}
