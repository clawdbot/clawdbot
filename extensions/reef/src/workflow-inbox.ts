import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { z } from "zod";
import { ReefInboxEntryParkedError } from "./transport.js";
import {
  ReefPeerIdentitySchema,
  sameReefPeerIdentity,
  type ReefPeerIdentity,
} from "./friend-types.js";

export const REEF_WORKFLOW_API_VERSION = 1;
const WORKFLOW_PREFIX = "reef-workflow-v1\n";
const ProtocolSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const PeerSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const WorkflowEnvelopeSchema = z
  .object({
    protocol: ProtocolSchema,
    messageId: z.string().min(1).max(200),
    payload: z.json(),
  })
  .strict();

export type ReefWorkflowMessage = {
  protocol: string;
  peer: string;
  messageId: string;
  transportMessageId: string;
  payload: unknown;
};

export type ReefWorkflowInboxRegistration = {
  protocol: string;
  peer: string;
  expectedPeer: ReefPeerIdentity;
  /** Resolve accepted only after committing the envelope to durable, idempotent storage. */
  accept: (message: ReefWorkflowMessage) => Promise<{ accepted: boolean }>;
};

type RegisteredInbox = ReefWorkflowInboxRegistration & { active: boolean };
const inboxStore = createPluginRuntimeStore<Map<string, RegisteredInbox>>({
  key: "plugin-runtime:reef:workflow-inboxes:v1",
  errorMessage: "Reef workflow inbox registry unavailable",
});

function registeredInboxes(): Map<string, RegisteredInbox> {
  let inboxes = inboxStore.tryGetRuntime();
  if (!inboxes) {
    inboxes = new Map();
    inboxStore.setRuntime(inboxes);
  }
  return inboxes;
}

/** Opt in one protocol and cryptographically pinned peer; call the disposer on plugin stop. */
export function registerReefWorkflowInbox(options: ReefWorkflowInboxRegistration): () => void {
  const protocol = ProtocolSchema.parse(options.protocol);
  const peer = PeerSchema.parse(options.peer);
  const expectedPeer = ReefPeerIdentitySchema.parse(options.expectedPeer);
  const key = `${protocol}:${peer}`;
  const inboxes = registeredInboxes();
  if (inboxes.has(key)) {
    throw new Error("Reef workflow inbox is already registered");
  }
  const inbox = { protocol, peer, expectedPeer, accept: options.accept, active: true };
  inboxes.set(key, inbox);
  return () => {
    inbox.active = false;
    if (inboxes.get(key) === inbox) {
      inboxes.delete(key);
    }
  };
}

export function encodeReefWorkflowMessage(options: {
  protocol: string;
  messageId: string;
  payload: unknown;
}): string {
  const text = WORKFLOW_PREFIX + JSON.stringify(WorkflowEnvelopeSchema.parse(options));
  if (Buffer.byteLength(text, "utf8") > 32 * 1024) {
    throw new Error("Reef workflow envelope exceeds 32 KiB; split evidence before sending");
  }
  return text;
}

/** Called only after the owning flow has authenticated, decrypted, and guarded a message. */
export async function acceptReefWorkflowMessage(options: {
  text: string;
  peer: string;
  identity: ReefPeerIdentity;
  transportMessageId: string;
}): Promise<boolean> {
  if (!options.text.startsWith(WORKFLOW_PREFIX)) {
    return false;
  }
  const parsed = WorkflowEnvelopeSchema.safeParse(
    JSON.parse(options.text.slice(WORKFLOW_PREFIX.length)),
  );
  if (!parsed.success) {
    throw new Error("Invalid Reef workflow envelope");
  }
  const inbox = registeredInboxes().get(`${parsed.data.protocol}:${options.peer}`);
  if (!inbox?.active || !sameReefPeerIdentity(inbox.expectedPeer, options.identity)) {
    throw new ReefInboxEntryParkedError("Reef workflow inbox unavailable for this protocol and peer identity");
  }
  let result: { accepted: boolean };
  try {
    result = await inbox.accept({
      ...parsed.data,
      peer: options.peer,
      transportMessageId: options.transportMessageId,
    });
  } catch {
    throw new ReefInboxEntryParkedError("Reef workflow inbox commit failed; admission remains pending");
  }
  if (!inbox.active || result?.accepted !== true) {
    throw new ReefInboxEntryParkedError("Reef workflow admission deferred; durable acceptance is required");
  }
  return true;
}
