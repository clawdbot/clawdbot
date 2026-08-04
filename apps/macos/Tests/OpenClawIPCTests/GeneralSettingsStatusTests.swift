import Testing
@testable import OpenClaw

@MainActor
struct GeneralSettingsStatusTests {
    @Test func `connected remote gateway is healthy`() {
        let status = GeneralStatusPresentation.resolve(
            mode: .remote,
            isPaused: false,
            controlState: .connected)

        #expect(status.title == "OpenClaw active")
        #expect(status.subtitle == "Connected to your remote Gateway.")
        #expect(status.tone == .healthy)
        #expect(!status.showsConnectionAction)
    }

    @Test func `remote authentication failure is actionable`() {
        let reason = RemoteGatewayAuthIssue.tokenMismatch.statusMessage
        let status = GeneralStatusPresentation.resolve(
            mode: .remote,
            isPaused: false,
            controlState: .degraded(reason))

        #expect(status.title == "OpenClaw needs attention")
        #expect(status.subtitle.contains(reason))
        #expect(status.subtitle.contains("Open Connection settings"))
        #expect(status.tone == .attention)
        #expect(status.showsConnectionAction)
    }

    @Test func `remote connection attempt is transient`() {
        let status = GeneralStatusPresentation.resolve(
            mode: .remote,
            isPaused: false,
            controlState: .connecting)

        #expect(status.title == "OpenClaw connecting")
        #expect(status.subtitle == "Connecting to your remote Gateway…")
        #expect(status.tone == .transient)
        #expect(!status.showsConnectionAction)
    }

    @Test func `local and unconfigured copy stay independent of remote health`() {
        let local = GeneralStatusPresentation.resolve(
            mode: .local,
            isPaused: false,
            controlState: .degraded("ignored"))
        let unconfigured = GeneralStatusPresentation.resolve(
            mode: .unconfigured,
            isPaused: false,
            controlState: .degraded("ignored"))

        #expect(local.subtitle == "Processing messages through the local Gateway on this Mac.")
        #expect(local.tone == .healthy)
        #expect(unconfigured.subtitle == "Ready to run after you choose a Gateway connection.")
        #expect(unconfigured.tone == .healthy)
    }
}
