import Foundation
import Testing
@testable import OpenClaw

struct OpenClawLoggingTests {
    @Test(arguments: ["synthetic-private-payload", "first line\nsecond line", ""])
    func `private values are removed before sink delivery`(privateValue: String) {
        let publicValue = "synthetic-public-value"
        let message: Logger.Message =
            "event public=\(publicValue, privacy: .public) private=\(privateValue, privacy: .private) count=\(3)"
        #expect(message.description == "event public=synthetic-public-value private=<private> count=3")

        // Voice diagnostics concatenate ordinary Strings before converting to Logger.Message.
        let joined = "first=\(privateValue, privacy: .private) " + "second=\(privateValue, privacy: .private)"
        let forwarded: Logger.Message = "\(joined)"
        #expect(forwarded.description == "first=<private> second=<private>")
    }

    @Test
    func `private hash correlates without retaining the value`() {
        let firstUID = "synthetic-microphone-a"
        let secondUID = "synthetic-microphone-b"
        let first: Logger.Message = "uid=\(firstUID, privacy: .private(mask: .hash))"
        let repeated: Logger.Message = "uid=\(firstUID, privacy: .private(mask: .hash))"
        let different: Logger.Message = "uid=\(secondUID, privacy: .private(mask: .hash))"

        #expect(first == repeated)
        #expect(first != different)
        #expect(!first.description.contains(firstUID))
        #expect(!different.description.contains(secondUID))
        #expect(first.description != "uid=<private>")
    }

    @Test
    func `private values are not described`() {
        let value = DescribedValue()
        var factoryCalls = 0
        func makeValue() -> DescribedValue {
            factoryCalls += 1
            return value
        }
        let hidden: Logger.Message = "value=\(makeValue(), privacy: .private)"
        #expect(hidden.description == "value=<private>")
        #expect(value.descriptionReads == 0)
        #expect(factoryCalls == 0)

        let visible: Logger.Message = "value=\(makeValue(), privacy: .public)"
        #expect(visible.description == "value=synthetic-description")
        #expect(value.descriptionReads == 1)
        #expect(factoryCalls == 1)
    }
}

private final class DescribedValue: CustomStringConvertible {
    var descriptionReads = 0

    var description: String {
        self.descriptionReads += 1
        return "synthetic-description"
    }
}
