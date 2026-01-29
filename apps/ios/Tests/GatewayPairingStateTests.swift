import MoltbotKit
import MoltbotProtocol
import Foundation
import Testing
@testable import Moltbot

@Suite(.serialized) struct GatewayPairingStateTests {
    @Test @MainActor func pairingPendingTransitionsAcrossRoles() {
        let appModel = NodeAppModel()

        #expect(appModel.gatewayPairingState == .none)

        appModel._test_updatePairingPending(role: .operator, reason: "Pairing required")
        #expect(appModel.gatewayPairingState == .operatorPending)

        appModel._test_updatePairingPending(role: .node, reason: "Awaiting approval")
        #expect(appModel.gatewayPairingState == .bothPending)

        appModel._test_updatePairingPending(role: .operator, reason: "Disconnected")
        #expect(appModel.gatewayPairingState == .nodePending)

        appModel._test_clearPairingPending()
        #expect(appModel.gatewayPairingState == .none)
    }

    @Test @MainActor func pairingPendingClearsOnEmptyReason() {
        let appModel = NodeAppModel()
        appModel._test_setPairingPending(role: .node, pending: true)
        #expect(appModel.gatewayPairingState == .nodePending)

        appModel._test_updatePairingPending(role: .node, reason: "   ")
        #expect(appModel.gatewayPairingState == .none)
    }

    @Test @MainActor func pairingRequestedEventSetsPendingForOperatorRole() async {
        let appModel = NodeAppModel()
        let myDeviceId = "test-device-123"

        let payload: [String: MoltbotProtocol.AnyCodable] = [
            "deviceId": MoltbotProtocol.AnyCodable(myDeviceId),
            "role": MoltbotProtocol.AnyCodable("operator"),
        ]
        let evt = EventFrame(
            type: "event",
            event: "device.pair.requested",
            payload: MoltbotProtocol.AnyCodable(payload),
            seq: nil,
            stateversion: nil)

        await appModel._test_handlePairingEvent(evt, myDeviceId: myDeviceId)

        #expect(appModel.gatewayPairingState == .operatorPending)
    }

    @Test @MainActor func pairingRequestedEventSetsPendingForNodeRole() async {
        let appModel = NodeAppModel()
        let myDeviceId = "test-device-456"

        let payload: [String: MoltbotProtocol.AnyCodable] = [
            "deviceId": MoltbotProtocol.AnyCodable(myDeviceId),
            "role": MoltbotProtocol.AnyCodable("node"),
        ]
        let evt = EventFrame(
            type: "event",
            event: "device.pair.requested",
            payload: MoltbotProtocol.AnyCodable(payload),
            seq: nil,
            stateversion: nil)

        await appModel._test_handlePairingEvent(evt, myDeviceId: myDeviceId)

        #expect(appModel.gatewayPairingState == .nodePending)
    }

    @Test @MainActor func pairingRequestedEventIgnoresOtherDevices() async {
        let appModel = NodeAppModel()
        let myDeviceId = "test-device-mine"

        let payload: [String: MoltbotProtocol.AnyCodable] = [
            "deviceId": MoltbotProtocol.AnyCodable("different-device"),
            "role": MoltbotProtocol.AnyCodable("operator"),
        ]
        let evt = EventFrame(
            type: "event",
            event: "device.pair.requested",
            payload: MoltbotProtocol.AnyCodable(payload),
            seq: nil,
            stateversion: nil)

        await appModel._test_handlePairingEvent(evt, myDeviceId: myDeviceId)

        #expect(appModel.gatewayPairingState == .none)
    }

    @Test @MainActor func pairingResolvedEventClearsPending() async {
        let appModel = NodeAppModel()
        let myDeviceId = "test-device-789"

        // First set pending state
        appModel._test_setPairingPending(role: .operator, pending: true)
        appModel._test_setPairingPending(role: .node, pending: true)
        #expect(appModel.gatewayPairingState == .bothPending)

        // Receive resolved event
        let payload: [String: MoltbotProtocol.AnyCodable] = [
            "deviceId": MoltbotProtocol.AnyCodable(myDeviceId),
            "decision": MoltbotProtocol.AnyCodable("approved"),
        ]
        let evt = EventFrame(
            type: "event",
            event: "device.pair.resolved",
            payload: MoltbotProtocol.AnyCodable(payload),
            seq: nil,
            stateversion: nil)

        await appModel._test_handlePairingEvent(evt, myDeviceId: myDeviceId)

        #expect(appModel.gatewayPairingState == .none)
    }

    @Test @MainActor func pairingResolvedEventIgnoresOtherDevices() async {
        let appModel = NodeAppModel()
        let myDeviceId = "test-device-mine"

        // Set pending state
        appModel._test_setPairingPending(role: .operator, pending: true)
        #expect(appModel.gatewayPairingState == .operatorPending)

        // Receive resolved event for different device
        let payload: [String: MoltbotProtocol.AnyCodable] = [
            "deviceId": MoltbotProtocol.AnyCodable("different-device"),
            "decision": MoltbotProtocol.AnyCodable("approved"),
        ]
        let evt = EventFrame(
            type: "event",
            event: "device.pair.resolved",
            payload: MoltbotProtocol.AnyCodable(payload),
            seq: nil,
            stateversion: nil)

        await appModel._test_handlePairingEvent(evt, myDeviceId: myDeviceId)

        // State unchanged
        #expect(appModel.gatewayPairingState == .operatorPending)
    }
}
