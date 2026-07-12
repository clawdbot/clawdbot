import Foundation
@testable import OpenClawKit
import Testing

struct WatchCommandsTests {
    @Test func `app snapshot dual writes semantic and legacy status fields`() throws {
        let message = OpenClawWatchAppSnapshotMessage(
            gatewayStatus: OpenClawWatchAppStatus(code: .gatewayConnected),
            gatewayStatusText: "Connected",
            gatewayConnected: true,
            agentName: "Main",
            sessionKey: "main",
            talkStatus: OpenClawWatchAppStatus(code: .talkOff),
            talkStatusText: "Off",
            talkEnabled: false,
            talkListening: false,
            talkSpeaking: false,
            pendingApprovalCount: 0,
            chatStatus: OpenClawWatchAppStatus(code: .chatNoMessages),
            chatStatusText: "No chat messages yet")

        let encoded = try JSONEncoder().encode(message)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(object["gatewayStatus"] != nil)
        #expect(object["gatewayStatusText"] as? String == "Connected")
        #expect(object["talkStatus"] != nil)
        #expect(object["talkStatusText"] as? String == "Off")
        #expect(object["chatStatus"] != nil)
        #expect(object["chatStatusText"] as? String == "No chat messages yet")
    }

    @Test func `shipped snapshot initializer remains available`() {
        let message = OpenClawWatchAppSnapshotMessage(
            gatewayStatusText: "Connected",
            gatewayConnected: true,
            agentName: "Main",
            sessionKey: "main",
            talkStatusText: "Off",
            talkEnabled: false,
            talkListening: false,
            talkSpeaking: false,
            pendingApprovalCount: 0)

        #expect(message.gatewayStatus.code == .gatewayConnected)
        #expect(message.talkStatus.code == .talkOff)
    }

    @Test func `semantic chat status always writes the shipped text field`() throws {
        let message = OpenClawWatchAppSnapshotMessage(
            gatewayStatus: OpenClawWatchAppStatus(code: .gatewayConnected),
            gatewayStatusText: "Connected",
            gatewayConnected: true,
            agentName: "Main",
            sessionKey: "main",
            talkStatus: OpenClawWatchAppStatus(code: .talkOff),
            talkStatusText: "Off",
            talkEnabled: false,
            talkListening: false,
            talkSpeaking: false,
            pendingApprovalCount: 0,
            chatStatus: OpenClawWatchAppStatus(code: .chatUnavailable))

        let encoded = try JSONEncoder().encode(message)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(message.chatStatusText == "Chat unavailable")
        #expect(object["chatStatusText"] as? String == "Chat unavailable")
    }

    @Test func `unknown semantic statuses fall back to legacy text`() throws {
        let json = """
        {
          "type": "watch.appSnapshot",
          "gatewayStatus": {"code": "futureGateway", "arguments": []},
          "gatewayStatusText": "Future gateway state",
          "gatewayConnected": true,
          "agentName": "Main",
          "sessionKey": "main",
          "talkStatus": {"code": "futureTalk", "arguments": []},
          "talkStatusText": "Future Talk state",
          "talkEnabled": false,
          "talkListening": false,
          "talkSpeaking": true,
          "pendingApprovalCount": 0,
          "chatStatus": {"code": "futureChat", "arguments": []},
          "chatStatusText": "Future chat state"
        }
        """

        let message = try JSONDecoder().decode(
            OpenClawWatchAppSnapshotMessage.self,
            from: Data(json.utf8))

        #expect(message.gatewayStatus == OpenClawWatchAppStatus(
            code: .legacy,
            verbatim: "Future gateway state"))
        #expect(message.talkStatus == OpenClawWatchAppStatus(
            code: .legacy,
            verbatim: "Future Talk state"))
        #expect(message.chatStatus == OpenClawWatchAppStatus(
            code: .legacy,
            verbatim: "Future chat state"))
    }

    @Test func `approval resolution dual writes semantic and legacy outcomes`() throws {
        let message = OpenClawWatchExecApprovalResolvedMessage(
            approvalId: "approval-a",
            outcome: .allowedAlways,
            source: "another-reviewer",
            outcomeText: "This approval was already set to Always Allow.")

        let encoded = try JSONEncoder().encode(message)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(object["outcome"] as? String == "allowedAlways")
        #expect(object["outcomeText"] as? String ==
            "This approval was already set to Always Allow.")
    }
}
