import Darwin
import Foundation
import Testing

@Suite(.serialized)
struct CoverageDumpTests {
    @Test func periodicallyFlushCoverage() async {
        guard ProcessInfo.processInfo.environment["LLVM_PROFILE_FILE"] != nil else { return }
        guard let writeProfile = resolveProfileWriteFile() else { return }
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            _ = writeProfile()
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }
}

private typealias ProfileWriteFn = @convention(c) () -> Int32

private func resolveProfileWriteFile() -> ProfileWriteFn? {
    let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "__llvm_profile_write_file")
    guard let symbol else { return nil }
    return unsafeBitCast(symbol, to: ProfileWriteFn.self)
}
