import Darwin
import Foundation

extension FileHandle {
    /// Marks a pipe/socket write end so a vanished reader fails the write with a
    /// thrown EPIPE instead of raising SIGPIPE, which kills the whole process.
    /// Required on every write end whose reader is another process that can exit.
    @discardableResult
    func disableSIGPIPE() -> Bool {
        fcntl(self.fileDescriptor, F_SETNOSIGPIPE, 1) != -1
    }

    /// Reads until EOF using the throwing FileHandle API and returns empty `Data` on failure.
    ///
    /// Important: Avoid legacy, non-throwing FileHandle read APIs (e.g. `readDataToEndOfFile()` and
    /// `availableData`). They can raise Objective-C exceptions when the handle is closed/invalid, which
    /// will abort the process.
    func readToEndSafely() -> Data {
        do {
            return try self.readToEnd() ?? Data()
        } catch {
            return Data()
        }
    }

    /// Reads up to `count` bytes using the throwing FileHandle API and returns empty `Data` on failure/EOF.
    ///
    /// Important: Use this instead of `availableData` in callbacks like `readabilityHandler` to avoid
    /// Objective-C exceptions terminating the process.
    func readSafely(upToCount count: Int) -> Data {
        do {
            return try self.read(upToCount: count) ?? Data()
        } catch {
            return Data()
        }
    }
}
