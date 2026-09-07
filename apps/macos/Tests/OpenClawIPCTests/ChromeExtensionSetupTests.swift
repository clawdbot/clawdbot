import Testing
@testable import OpenClaw

struct ChromeExtensionSetupTests {
    @Test func `registration and pending Chrome approval do not imply installed or connected`() throws {
        let result = try ChromeExtensionSetup.readResult("""
        {"registrations":[{"product":"chrome","state":"owned"}],"storeInstallRequests":[{"state":"requested"}],
         "storeDiscovered":[{"product":"chrome","enabled":false,"awaitingApproval":true}],"discovered":[]}
        """)
        #expect(result.nativeHostRegistered)
        #expect(result.installRequested)
        #expect(result.discoveredProfiles == 0)
    }

    @Test func `only enabled Store discoveries count as installed profiles`() throws {
        let result = try ChromeExtensionSetup.readResult("""
        {"registrations":[{"product":"chrome","state":"foreign"}],"storeInstallRequests":[{"state":"foreign"}],
         "storeDiscovered":[{"product":"chrome","enabled":false},{"product":"chrome","enabled":true}],
         "discovered":[{"product":"chrome"}]}
        """)
        #expect(!result.nativeHostRegistered)
        #expect(!result.installRequested)
        #expect(result.discoveredProfiles == 2)
    }

    @Test func `another browser cannot mask failed Chrome registration or pending approval`() throws {
        let result = try ChromeExtensionSetup.readResult("""
        {"registrations":[{"product":"chromium","state":"owned"},
          {"product":"chrome","state":"owned","issue":"runtime unavailable"}],
         "storeInstallRequests":[{"state":"requested"}],
         "storeDiscovered":[{"product":"chrome","enabled":false},{"product":"chromium","enabled":true}],
         "discovered":[{"product":"chrome-for-testing"}]}
        """)
        #expect(!result.nativeHostRegistered)
        #expect(result.discoveredProfiles == 0)
        #expect(result.installRequested)
    }
}
