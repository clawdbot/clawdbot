import Foundation
import Testing

struct TestIsolationTests {
    private enum BodyFailure: Error {
        case expected
    }

    @Test(arguments: [
        (initial: nil, temporary: "temporary"),
        (initial: nil, temporary: nil),
        (initial: "", temporary: "temporary"),
        (initial: "", temporary: nil),
        (initial: " original \t\n", temporary: "temporary"),
        (initial: " original \t\n", temporary: nil),
    ] as [(initial: String?, temporary: String?)], [false, true])
    @MainActor
    func `environment values restore exactly after completion or throw`(
        _ values: (initial: String?, temporary: String?),
        shouldThrow: Bool) async
    {
        let key = "OPENCLAW_TEST_ISOLATION_\(UUID().uuidString.replacingOccurrences(of: "-", with: "_"))"
        await TestIsolationLock.shared.acquire()
        #expect(getenv(key) == nil)
        if let initial = values.initial {
            #expect(setenv(key, initial, 1) == 0)
        }
        await TestIsolationLock.shared.release()

        var bodyRan = false
        var didThrow = false
        do {
            let result = try await TestIsolation.withEnvValues([key: values.temporary]) {
                bodyRan = true
                #expect(getenv(key).map { String(cString: $0) } == values.temporary)
                if shouldThrow {
                    throw BodyFailure.expected
                }
                return "completed"
            }
            #expect(result == "completed")
        } catch {
            didThrow = true
            #expect(error as? BodyFailure == .expected)
        }
        #expect(bodyRan)
        #expect(didThrow == shouldThrow)

        await TestIsolationLock.shared.acquire()
        #expect(getenv(key).map { String(cString: $0) } == values.initial)
        #expect(unsetenv(key) == 0)
        await TestIsolationLock.shared.release()
    }
}
