import Foundation
import GRDB

extension OpenClawChatSQLiteTranscriptCache {
    nonisolated static func command(
        from row: Row,
        in db: Database,
        gatewayID: String) throws -> OpenClawChatOutboxCommand
    {
        let id: String = row["client_uuid"]
        let attachmentRows = try Row.fetchAll(
            db,
            sql: """
            SELECT type, mime_type, file_name, payload, duration_seconds
            FROM outbox_attachments
            WHERE gateway_id = ? AND command_id = ? ORDER BY position
            """,
            arguments: [gatewayID, id])
        let attachments = attachmentRows.map { attachmentRow in
            OpenClawChatOutboxAttachment(
                type: attachmentRow["type"],
                mimeType: attachmentRow["mime_type"],
                fileName: attachmentRow["file_name"],
                data: attachmentRow["payload"],
                durationSeconds: attachmentRow["duration_seconds"])
        }
        let statusRaw: String = row["status"]
        guard let status = OpenClawChatOutboxCommand.Status(rawValue: statusRaw) else {
            throw DatabaseError(message: "unknown outbox status")
        }
        let lastError: String = row["last_error"]
        let queueModeRaw: String? = row["send_queue_mode"]
        let queueMode: OpenClawChatQueueMode?
        if let queueModeRaw {
            guard let decodedQueueMode = OpenClawChatQueueMode(rawValue: queueModeRaw) else {
                throw DatabaseError(message: "unknown outbox queue mode")
            }
            queueMode = decodedQueueMode
        } else {
            queueMode = nil
        }
        let expectedLeafState: String? = row["send_expected_leaf_state"]
        let expectedLeafEntryID: String? = row["send_expected_leaf_entry_id"]
        let expectedLeaf: OpenClawChatLeafExpectation = switch expectedLeafState {
        case nil, "unavailable": if expectedLeafEntryID == nil {
                .unavailable
            } else {
                throw DatabaseError(message: "contradictory outbox expected leaf")
            }
        case "empty": if expectedLeafEntryID == nil {
                .empty
            } else {
                throw DatabaseError(message: "contradictory outbox expected leaf")
            }
        case "entry": if let expectedLeafEntryID, !expectedLeafEntryID.isEmpty {
                .entry(expectedLeafEntryID)
            } else {
                throw DatabaseError(message: "missing outbox expected leaf entry")
            }
        default: throw DatabaseError(message: "unknown outbox expected leaf state")
        }
        let structuredMessageText: String? = row["structured_message_text"]
        let sessionID: String? = row["send_session_id"]
        let replyToID: String? = row["send_reply_to_id"]
        let unstructuredMessageFallback: String? = row["send_unstructured_message_fallback"]
        let requiresStructuredDelivery: Int? = row["send_requires_structured_delivery"]
        let expectedSettingsJSON: String? = row["expected_settings_json"]
        let expectedSessionSettings = try Self.decodeSessionSettingsExpectation(expectedSettingsJSON)
        guard requiresStructuredDelivery == nil || requiresStructuredDelivery == 0 ||
            requiresStructuredDelivery == 1
        else { throw DatabaseError(message: "unknown structured delivery flag") }
        let hasSendContext = structuredMessageText != nil || sessionID != nil || queueMode != nil ||
            replyToID != nil || expectedLeaf != .unavailable || unstructuredMessageFallback != nil ||
            requiresStructuredDelivery != nil || expectedSessionSettings != nil
        let routingContract: String = row["routing_contract"]
        let agentIDRaw: String = row["agent_id"]
        let agentID = Self.optionalAgentID(agentIDRaw)
        let text: String = row["text"]
        return OpenClawChatOutboxCommand(
            id: id,
            sessionKey: row["session_key"],
            deliverySessionKey: row["delivery_session_key"],
            routingContract: routingContract,
            agentID: agentID,
            branchEpoch: row["branch_epoch"],
            scopeBranchEpoch: row["scope_branch_epoch"],
            structuredMessageText: structuredMessageText,
            sendContext: hasSendContext
                ? OpenClawChatSendContext(
                    agentID: agentID,
                    expectedSessionRoutingContract: routingContract,
                    expectedSessionSettings: expectedSessionSettings,
                    sessionID: sessionID,
                    queueMode: queueMode,
                    replyToID: replyToID,
                    expectedLeaf: expectedLeaf,
                    unstructuredMessageFallback: unstructuredMessageFallback,
                    requiresStructuredDelivery: requiresStructuredDelivery == 1)
                : nil,
            text: text,
            attachments: attachments,
            thinking: row["thinking"],
            createdAt: row["created_at"],
            status: status,
            attemptVersion: row["attempt_version"],
            retryCount: row["retry_count"],
            lastError: lastError.isEmpty ? nil : lastError)
    }

    nonisolated static func storedSendContext(
        _ context: OpenClawChatSendContext?) -> (
        expectedLeaf: (state: String, entryID: String?)?,
        expectedSettingsJSON: String?)
    {
        (context?.expectedLeaf.storedValue, self.encodeSessionSettingsExpectation(context?.expectedSessionSettings))
    }

    nonisolated static func normalizedAgentID(_ agentID: String?) -> String {
        agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    nonisolated static func optionalAgentID(_ agentID: String) -> String? {
        let normalized = self.normalizedAgentID(agentID)
        return normalized.isEmpty ? nil : normalized
    }
}
