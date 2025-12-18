import Testing
@testable import Clawdis

@Suite struct NodeListTests {
    @Test func nodeListMapsGatewayPayloadIncludingHardwareAndCaps() async {
        let payload = ControlRequestHandler.GatewayNodeListPayload(
            ts: 123,
            nodes: [
                ControlRequestHandler.GatewayNodeListPayload.Node(
                    nodeId: "n1",
                    displayName: "Iris",
                    platform: "iOS",
                    version: "1.0",
                    deviceFamily: "iPad",
                    modelIdentifier: "iPad14,5",
                    remoteIp: "192.168.0.88",
                    connected: true,
                    paired: true,
                    caps: ["canvas", "camera"]),
                ControlRequestHandler.GatewayNodeListPayload.Node(
                    nodeId: "n2",
                    displayName: "Offline",
                    platform: "iOS",
                    version: "1.0",
                    deviceFamily: "iPhone",
                    modelIdentifier: "iPhone14,2",
                    remoteIp: nil,
                    connected: false,
                    paired: true,
                    caps: nil),
            ])

        let res = ControlRequestHandler.buildNodeListResult(payload: payload)

        #expect(res.ts == 123)
        #expect(res.pairedNodeIds.sorted() == ["n1", "n2"])
        #expect(res.connectedNodeIds == ["n1"])

        let iris = res.nodes.first { $0.nodeId == "n1" }
        #expect(iris?.remoteAddress == "192.168.0.88")
        #expect(iris?.deviceFamily == "iPad")
        #expect(iris?.modelIdentifier == "iPad14,5")
        #expect(iris?.capabilities?.sorted() == ["camera", "canvas"])
    }
}
