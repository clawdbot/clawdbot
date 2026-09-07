// Nextcloud Talk plugin module implements monitor fixtures behavior.
import { generateNextcloudTalkSignature } from "./signature.js";

export function createSignedCreateMessageRequest(params?: { backend?: string }) {
  const payload = {
    type: "Create",
    actor: { type: "Person", id: "alice", name: "Alice" },
    object: {
      type: "Note",
      id: "msg-1",
      name: "hello",
      content: "hello",
      mediaType: "text/plain",
    },
    target: { type: "Collection", id: "room-1", name: "Room 1" },
  };
  const body = JSON.stringify(payload);
  const { random, signature } = generateNextcloudTalkSignature({
    body,
    secret: "nextcloud-secret", // pragma: allowlist secret
  });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
      "x-nextcloud-talk-backend": params?.backend ?? "https://nextcloud.example",
    },
  };
}

/** Redacted Talk 23 / Nextcloud 33 file-bearing message Activity fixture. */
export function createSignedFileSharedActivityRequest(params?: { backend?: string }) {
  const payload = {
    type: "Activity",
    actor: { type: "Person", id: "users/alice", name: "Alice" },
    object: {
      type: "Note",
      id: "4242",
      name: "message",
      content: JSON.stringify({
        message: "@openclaw please inspect this receipt",
        parameters: {
          actor: { type: "user", id: "alice", name: "Alice" },
          file: {
            type: "file",
            id: "9001",
            name: "receipt.pdf",
            size: "24576",
            path: "receipt.pdf",
            link: "https://nextcloud.example/s/redacted-share-token",
            etag: "redacted-etag",
            permissions: "1",
            mimetype: "application/pdf",
            "preview-available": "yes",
            "hide-download": "no",
          },
        },
      }),
      mediaType: "text/markdown",
    },
    target: { type: "Collection", id: "redacted-room-token", name: "Receipts" },
  };
  const body = JSON.stringify(payload);
  const { random, signature } = generateNextcloudTalkSignature({
    body,
    secret: "nextcloud-secret", // pragma: allowlist secret
  });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
      "x-nextcloud-talk-backend": params?.backend ?? "https://nextcloud.example",
    },
  };
}

/** Redacted canonical native Talk voice-message Activity fixture. */
export function createSignedVoiceMessageActivityRequest(params?: { backend?: string }) {
  const payload = {
    type: "Activity",
    actor: { type: "Person", id: "users/alice", name: "Alice" },
    object: {
      type: "Note",
      id: "4250",
      name: "file_shared",
      content: JSON.stringify({
        message: "{file}",
        parameters: {
          actor: { type: "user", id: "alice", name: "Alice" },
          file: {
            type: "file",
            id: "9010",
            name: "voice-note.wav",
            size: "557804",
            path: "voice-note.wav",
            link: "https://nextcloud.example/s/redacted-voice-share-token",
            etag: "redacted-etag",
            permissions: "1",
            mimetype: "audio/wav",
            "preview-available": "no",
            "hide-download": "no",
          },
        },
      }),
      mediaType: "text/markdown",
    },
    target: { type: "Collection", id: "redacted-room-token", name: "Voice notes" },
  };
  const body = JSON.stringify(payload);
  const { random, signature } = generateNextcloudTalkSignature({
    body,
    secret: "nextcloud-secret", // pragma: allowlist secret
  });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
      "x-nextcloud-talk-backend": params?.backend ?? "https://nextcloud.example",
    },
  };
}
