import Foundation
import OpenClawKit

public struct OpenClawWatchMessageOwner: Equatable, Sendable {
    public let gatewayStableID: String
    public let routeGeneration: String?

    public init(gatewayStableID: String, routeGeneration: String?) {
        self.gatewayStableID = gatewayStableID
        self.routeGeneration = routeGeneration
    }

    public init(context: OpenClawWatchChatDeliveryContext) {
        self.init(gatewayStableID: context.gatewayStableID, routeGeneration: context.routeGeneration)
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        Data(lhs.gatewayStableID.utf8) == Data(rhs.gatewayStableID.utf8) &&
            lhs.routeGeneration == rhs.routeGeneration
    }
}

public struct OpenClawWatchMessageRoute: Equatable, Sendable {
    public let owner: OpenClawWatchMessageOwner
    public let routingIdentity: OpenClawChatSessionRoutingIdentity
}

public enum OpenClawWatchMessagePhase: String, Codable, Sendable {
    case queued
    case sending
    case accepted
    case receiptReady
    case received
    case needsReview
    case tombstone
}

public enum OpenClawWatchMessageReceiptDestination: String, Codable, Sendable {
    case watch
    case phone
}

public struct OpenClawWatchMessageEntry: Identifiable, Equatable, Sendable {
    public let commandId: String
    /// SQLite and the wire protocol distinguish canonically equivalent UTF-8 identifiers.
    public var id: Data {
        Data(self.commandId.utf8)
    }

    public let owner: OpenClawWatchMessageOwner?
    public let command: OpenClawWatchChatDeliveryCommand?
    public let displayText: String?
    public let phase: OpenClawWatchMessagePhase
    public let destination: OpenClawWatchMessageReceiptDestination
    public let admittedAtMs: Int64
    public let expiresAtMs: Int64?
    public let attemptVersion: Int64
    public let acceptedRunID: String?
    public let receipt: OpenClawWatchChatDeliveryReceipt?

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id &&
            lhs.owner == rhs.owner &&
            lhs.command == rhs.command &&
            lhs.displayText == rhs.displayText &&
            lhs.phase == rhs.phase &&
            lhs.destination == rhs.destination &&
            lhs.admittedAtMs == rhs.admittedAtMs &&
            lhs.expiresAtMs == rhs.expiresAtMs &&
            lhs.attemptVersion == rhs.attemptVersion &&
            lhs.acceptedRunID == rhs.acceptedRunID &&
            lhs.receipt == rhs.receipt
    }
}

public enum OpenClawWatchMessageMutation: Equatable, Sendable {
    case applied
    case missing
    case superseded
}

/// A decoded legacy snapshot, not a second runtime queue. Missing ownership
/// never becomes permission to send an imported message.
public struct OpenClawWatchMessageLegacyImport: Sendable {
    public struct Message: Sendable {
        public let id: String
        public let gatewayStableID: String?
        public let text: String
        public let submittedAtMs: Int64?

        public init(id: String, gatewayStableID: String?, text: String, submittedAtMs: Int64?) {
            self.id = id
            self.gatewayStableID = gatewayStableID
            self.text = text
            self.submittedAtMs = submittedAtMs
        }
    }

    public let messages: [Message]
    public let recentMessageIDs: [String]

    public init(messages: [Message], recentMessageIDs: [String]) {
        self.messages = messages
        self.recentMessageIDs = recentMessageIDs
    }
}
