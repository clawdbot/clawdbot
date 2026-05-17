import Testing
import AppKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct NodePairingApprovalPrompterTests {
    @Test func `node pairing approval prompter exercises`() async {
        await NodePairingApprovalPrompter.exerciseForTesting()
    }

    @Test func `pairing alert makes approve the primary action`() {
        let alert = NSAlert()
        PairingAlertSupport.configureDefaultPairingAlert(
            alert,
            messageText: "New Mac wants to connect",
            informativeText: "Approve this Mac app to control OpenClaw.",
            buttonTitles: PairingAlertSupport.ButtonTitles(approve: "Approve Mac"))

        #expect(alert.alertStyle == .informational)
        #expect(alert.buttons.map(\.title) == ["Approve Mac", "Not Now", "Reject"])
        if #available(macOS 11.0, *) {
            #expect(alert.buttons[2].hasDestructiveAction)
        }
    }

    @Test func `device pairing copy summarizes Mac requests`() {
        let request = DevicePairingApprovalPrompter.PendingRequest(
            requestId: "req-1",
            deviceId: "4a865684dbfa7b7937bd333813476ca88b672c2d02ad08fc52b80d88af4e82bd",
            publicKey: "pub",
            displayName: nil,
            platform: "MacIntel",
            clientId: nil,
            clientMode: nil,
            role: "operator",
            scopes: [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.pairing",
            ],
            remoteIp: "192.0.2.10",
            silent: nil,
            isRepair: nil,
            ts: 1)

        #expect(DevicePairingApprovalPrompter.alertTitle(for: request) == "New Mac wants to connect")
        #expect(DevicePairingApprovalPrompter.approveButtonTitle(for: request) == "Approve Mac")
        #expect(DevicePairingApprovalPrompter.deviceName(for: request) == "OpenClaw Mac app")
        #expect(DevicePairingApprovalPrompter.prettyPlatform(request.platform) == "Mac (Intel)")
        #expect(DevicePairingApprovalPrompter.shortIdentifier(request.deviceId) == "4a865684...f4e82bd")
        #expect(DevicePairingApprovalPrompter.friendlyScopeNames(request.scopes) == [
            "Admin access",
            "Read OpenClaw data",
            "Send messages and make changes",
            "Manage approvals",
            "Pair and repair devices",
        ])
        #expect(!DevicePairingApprovalPrompter.alertSummary(for: request).contains(request.deviceId))

        let accessory = DevicePairingApprovalPrompter.buildAccessoryView(for: request)
        #expect(accessory.frame.width >= 380)
        #expect(accessory.frame.height > 80)
    }
}
