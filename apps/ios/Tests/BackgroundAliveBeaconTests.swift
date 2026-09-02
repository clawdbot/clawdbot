import Foundation
import Testing
@testable import OpenClaw

struct BackgroundAliveBeaconTests {
    @Test func `normalize trigger accepts closed reasons`() {
        #expect(BackgroundAliveBeacon.normalizeTrigger("silent_push") == .silentPush)
        #expect(BackgroundAliveBeacon.normalizeTrigger(" bg_app_refresh ") == .bgAppRefresh)
        #expect(BackgroundAliveBeacon.normalizeTrigger("SIGNIFICANT_LOCATION") == .significantLocation)
    }

    @Test func `normalize trigger falls back to background`() {
        #expect(BackgroundAliveBeacon.normalizeTrigger("watch_prompt_action") == .background)
        #expect(BackgroundAliveBeacon.normalizeTrigger("") == .background)
    }

    @Test func `recent success throttle uses milliseconds`() {
        let now = Date(timeIntervalSince1970: 1000)

        #expect(BackgroundAliveBeacon.shouldSkipRecentSuccess(
            isGatewayConnected: true,
            now: now,
            lastSuccessAtMs: 999_500,
            minInterval: 10))
        #expect(!BackgroundAliveBeacon.shouldSkipRecentSuccess(
            isGatewayConnected: true,
            now: now,
            lastSuccessAtMs: 980_000,
            minInterval: 10))
    }

    @Test func `recent success throttle does not suppress disconnected wakes`() {
        let now = Date(timeIntervalSince1970: 1000)

        #expect(!BackgroundAliveBeacon.shouldSkipRecentSuccess(
            isGatewayConnected: false,
            now: now,
            lastSuccessAtMs: 999_500,
            minInterval: 10))
    }

    @Test func `make node event payload wraps presence payload JSON`() throws {
        let payload = BackgroundAliveBeacon.Payload(
            trigger: BackgroundAliveBeacon.Trigger.silentPush.rawValue,
            sentAtMs: 123,
            displayName: "Peter's iPhone",
            version: "2026.4.28",
            platform: "iOS 18.4.0",
            deviceFamily: "iPhone",
            modelIdentifier: "iPhone17,1",
            pushTransport: "relay")
        let requestJSON = try BackgroundAliveBeacon.makeNodeEventRequestPayloadJSON(payload: payload)
        let requestData = try #require(requestJSON.data(using: .utf8))
        let request = try JSONDecoder().decode(
            BackgroundAliveBeacon.NodeEventRequestPayload.self,
            from: requestData)

        #expect(request.event == "node.presence.alive")
        let payloadData = try #require(request.payloadJSON.data(using: .utf8))
        let decodedPayload = try #require(JSONSerialization.jsonObject(with: payloadData) as? [String: Any])
        let sentAtMs = try #require(decodedPayload["sentAtMs"] as? Int)
        #expect(decodedPayload["trigger"] as? String == "silent_push")
        #expect(sentAtMs == 123)
        #expect(decodedPayload["pushTransport"] as? String == "relay")
    }

    @Test func `old gateway ack does not count as handled`() throws {
        let data = try #require(#"{"ok":true}"#.data(using: .utf8))
        let response = try #require(BackgroundAliveBeacon.decodeResponse(data))

        #expect(response.ok == true)
        #expect(response.handled == nil)
    }
}
