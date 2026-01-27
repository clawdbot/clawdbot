import Foundation
import Testing
@testable import Moltbot

@Suite struct KeychainStoreTests {
    @Test func saveLoadUpdateDeleteRoundTrip() {
        let service = "com.clawdbot.tests.\(UUID().uuidString)"
        let account = "value"

        #expect(KeychainStore.delete(service: service, account: account))
        #expect(KeychainStore.loadString(service: service, account: account) == nil)

        #expect(KeychainStore.saveString("first", service: service, account: account))
        #expect(KeychainStore.loadString(service: service, account: account) == "first")

        #expect(KeychainStore.saveString("second", service: service, account: account))
        #expect(KeychainStore.loadString(service: service, account: account) == "second")

        #expect(KeychainStore.delete(service: service, account: account))
        #expect(KeychainStore.loadString(service: service, account: account) == nil)
    }
}
