import Foundation

public enum OpenClawChatQueueMode: String, Codable, Hashable, Sendable {
    case steer
    case followup
    case collect
    case interrupt
}

public enum OpenClawChatLeafExpectation: Hashable, Sendable {
    case unavailable
    case empty
    case entry(String)

    var storedValue: (state: String, entryID: String?) {
        switch self {
        case .unavailable:
            ("unavailable", nil)
        case .empty:
            ("empty", nil)
        case let .entry(entryID):
            ("entry", entryID)
        }
    }
}

public struct OpenClawChatSendContext: Hashable, Sendable {
    public let agentID: String?
    public let expectedSessionRoutingContract: String?
    public let expectedSessionSettings: OpenClawChatSessionSettingsExpectation?
    public let sessionID: String?
    public let queueMode: OpenClawChatQueueMode?
    public let replyToID: String?
    public let expectedLeaf: OpenClawChatLeafExpectation
    public let unstructuredMessageFallback: String?
    public let requiresStructuredDelivery: Bool

    public init(
        agentID: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        expectedSessionSettings: OpenClawChatSessionSettingsExpectation? = nil,
        sessionID: String? = nil,
        queueMode: OpenClawChatQueueMode? = nil,
        replyToID: String? = nil,
        expectedLeaf: OpenClawChatLeafExpectation = .unavailable,
        unstructuredMessageFallback: String? = nil,
        requiresStructuredDelivery: Bool = false)
    {
        self.agentID = agentID
        self.expectedSessionRoutingContract = expectedSessionRoutingContract
        self.expectedSessionSettings = expectedSessionSettings
        self.sessionID = sessionID
        self.queueMode = queueMode
        self.replyToID = replyToID
        self.expectedLeaf = expectedLeaf
        self.unstructuredMessageFallback = unstructuredMessageFallback
        self.requiresStructuredDelivery = requiresStructuredDelivery
    }

    func withExpectedSessionSettings(_ expectation: OpenClawChatSessionSettingsExpectation?) -> Self {
        Self(
            agentID: self.agentID,
            expectedSessionRoutingContract: self.expectedSessionRoutingContract,
            expectedSessionSettings: expectation,
            sessionID: self.sessionID,
            queueMode: self.queueMode,
            replyToID: self.replyToID,
            expectedLeaf: self.expectedLeaf,
            unstructuredMessageFallback: self.unstructuredMessageFallback,
            requiresStructuredDelivery: self.requiresStructuredDelivery)
    }
}
