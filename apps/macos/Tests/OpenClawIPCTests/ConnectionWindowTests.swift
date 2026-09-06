import Testing
@testable import OpenClaw

@MainActor
struct ConnectionWindowTests {
    @Test func `opening selects the requested tab before presenting and gates Debug`() {
        let opener = ConnectionWindowOpener()
        var presentedTabs: [ConnectionTab] = []
        opener.register { [weak opener] in
            guard let opener else { return }
            presentedTabs.append(opener.selectedTab)
        }

        opener.open(tab: .gateways, debugEnabled: false)
        opener.open(debugEnabled: false)
        opener.open(tab: .debug, debugEnabled: false)
        #expect(presentedTabs == [.gateways, .connection])
        #expect(opener.selectedTab == .connection)

        opener.open(tab: .debug, debugEnabled: true)
        #expect(presentedTabs == [.gateways, .connection, .debug])
        #expect(opener.selectedTab == .debug)
    }
}
