import Foundation
import OpenClawChatUI
import Testing

struct ChatSessionsCodingTests {
    @Test func `decodes session organization and read state fields`() throws {
        let data = Data(#"""
        {
            "key":"agent:main:telegram:group:1",
            "label":"Release room",
            "category":"Operations",
            "pinned":true,
            "archived":false,
            "unread":true,
            "lastReadAt":1720000000000,
            "lastActivityAt":1720000005000
        }
        """#.utf8)

        let entry = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)

        #expect(entry.label == "Release room")
        #expect(entry.category == "Operations")
        #expect(entry.pinned == true)
        #expect(entry.archived == false)
        #expect(entry.unread == true)
        #expect(entry.lastReadAt == 1_720_000_000_000)
        #expect(entry.lastActivityAt == 1_720_000_005_000)
    }
}
