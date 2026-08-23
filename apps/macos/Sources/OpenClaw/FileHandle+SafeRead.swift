import Foundation

extension FileHandle {
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
