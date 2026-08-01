import Foundation

public struct BridgeInvokeRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let command: String
    public let paramsJSON: String?
    public let nodeId: String?

    public init(
        type: String = "invoke",
        id: String,
        command: String,
        paramsJSON: String? = nil,
        nodeId: String? = nil)
    {
        self.type = type
        self.id = id
        self.command = command
        self.paramsJSON = paramsJSON
        self.nodeId = nodeId
    }
}

public struct BridgeInvokeResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let ok: Bool
    public let payload: AnyCodable?
    public let payloadJSON: String?
    public let error: OpenClawNodeError?

    public init(
        type: String = "invoke-res",
        id: String,
        ok: Bool,
        payload: AnyCodable? = nil,
        payloadJSON: String? = nil,
        error: OpenClawNodeError? = nil)
    {
        self.type = type
        self.id = id
        self.ok = ok
        self.payload = payload
        self.payloadJSON = payloadJSON
        self.error = error
    }
}
