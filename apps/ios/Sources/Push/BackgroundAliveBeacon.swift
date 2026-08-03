import Foundation
import UIKit

enum BackgroundAliveBeacon {
    static let eventName = "node.presence.alive"
    static let minSuccessIntervalSeconds: TimeInterval = 10 * 60

    enum Trigger: String, CaseIterable, Codable {
        case background
        case silentPush = "silent_push"
        case bgAppRefresh = "bg_app_refresh"
        case significantLocation = "significant_location"
        case manual
        case connect
    }

    struct Payload: Encodable {
        var trigger: String
        var sentAtMs: Int64
        var displayName: String
        var version: String
        var platform: String
        var deviceFamily: String
        var modelIdentifier: String
        var pushTransport: String?
    }

    struct NodeEventRequestPayload: Codable {
        var event: String = BackgroundAliveBeacon.eventName
        var payloadJSON: String
    }

    struct NodeEventResponsePayload: Decodable {
        var ok: Bool?
        var event: String?
        var handled: Bool?
        var reason: String?
    }

    static func normalizeTrigger(_ raw: String) -> Trigger {
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return Trigger(rawValue: normalized) ?? .background
    }

    static func shouldSkipRecentSuccess(
        isGatewayConnected: Bool,
        now: Date,
        lastSuccessAtMs: Double?,
        minInterval: TimeInterval = Self.minSuccessIntervalSeconds) -> Bool
    {
        guard isGatewayConnected else { return false }
        guard let lastSuccessAtMs, lastSuccessAtMs > 0 else { return false }
        let elapsed = now.timeIntervalSince1970 - (lastSuccessAtMs / 1000.0)
        return elapsed >= 0 && elapsed < minInterval
    }

    @MainActor
    static func makePayload(trigger: Trigger, displayName: String, pushTransport: String?) -> Payload {
        Payload(
            trigger: trigger.rawValue,
            sentAtMs: Int64(Date().timeIntervalSince1970 * 1000),
            displayName: displayName,
            version: DeviceInfoHelper.appVersion(),
            platform: DeviceInfoHelper.platformString(),
            deviceFamily: DeviceInfoHelper.deviceFamily(),
            modelIdentifier: DeviceInfoHelper.modelIdentifier(),
            pushTransport: pushTransport)
    }

    static func makeNodeEventRequestPayloadJSON(
        payload: Payload,
        encoder: JSONEncoder = JSONEncoder()) throws -> String
    {
        let payloadData = try encoder.encode(payload)
        guard let payloadJSON = String(data: payloadData, encoding: .utf8) else {
            throw EncodingError.invalidValue(payload, EncodingError.Context(
                codingPath: [],
                debugDescription: "Failed to encode background alive payload as UTF-8"))
        }
        let requestData = try encoder.encode(NodeEventRequestPayload(payloadJSON: payloadJSON))
        guard let requestJSON = String(data: requestData, encoding: .utf8) else {
            throw EncodingError.invalidValue(payload, EncodingError.Context(
                codingPath: [],
                debugDescription: "Failed to encode node.event payload as UTF-8"))
        }
        return requestJSON
    }

    static func decodeResponse(_ data: Data) -> NodeEventResponsePayload? {
        try? JSONDecoder().decode(NodeEventResponsePayload.self, from: data)
    }
}
