import Foundation

struct TalkRealtimeClientCreateParams: Encodable {
    var mode = "realtime"
    var provider: String?
    var transport = "webrtc"
    var brain = "agent-consult"
    var model: String?
    var voice: String?
}

struct TalkRealtimeClientSession: Decodable {
    let provider: String
    let transport: String
    let clientSecret: String
    let offerUrl: String?
    let offerHeaders: [String: String]?
    let model: String?
    let voice: String?
    let expiresAt: Double?

    var isWebRTC: Bool {
        self.transport.caseInsensitiveCompare("webrtc") == .orderedSame
    }
}

struct TalkRealtimeToolCallResponse: Decodable {
    let runId: String?
    let idempotencyKey: String?
}

struct TalkRealtimeServerEvent: Decodable {
    let type: String
    let itemId: String?
    let item: TalkRealtimeServerItem?
    let callId: String?
    let name: String?
    let delta: String?
    let arguments: String?
    let transcript: String?
    let text: String?

    enum CodingKeys: String, CodingKey {
        case type
        case itemId = "item_id"
        case item
        case callId = "call_id"
        case name
        case delta
        case arguments
        case transcript
        case text
    }

    var resolvedItemId: String? {
        self.itemId ?? self.item?.id
    }

    var resolvedCallId: String? {
        self.callId ?? self.item?.callId
    }

    var resolvedName: String? {
        self.name ?? self.item?.name
    }

    var resolvedArguments: String? {
        self.arguments ?? self.item?.arguments
    }
}

struct TalkRealtimeServerItem: Decodable {
    let id: String?
    let type: String?
    let callId: String?
    let name: String?
    let arguments: String?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case callId = "call_id"
        case name
        case arguments
    }
}
