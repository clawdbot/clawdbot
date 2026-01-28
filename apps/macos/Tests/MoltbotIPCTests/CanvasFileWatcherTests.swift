import Foundation
import os
import Testing
@testable import Moltbot

@Suite(.serialized) struct CanvasFileWatcherTests {
    private func makeTempDir() throws -> URL {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let dir = base.appendingPathComponent("moltbot-canvaswatch-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test func detectsInPlaceFileWrites() async throws {
        let dir = try self.makeTempDir()
        defer { try? FileManager().removeItem(at: dir) }

        let file = dir.appendingPathComponent("index.html")
        try "hello".write(to: file, atomically: false, encoding: .utf8)

        let fired = OSAllocatedUnfairLock(initialState: false)
        let waitState = OSAllocatedUnfairLock<(fired: Bool, cont: CheckedContinuation<Void, Never>?)>(
            initialState: (false, nil))

        func waitForFire(timeoutNs: UInt64) async -> Bool {
            await withTaskGroup(of: Bool.self) { group in
                group.addTask {
                    await withCheckedContinuation { cont in
                        let resumeImmediately = waitState.withLock { state in
                            if state.fired { return true }
                            state.cont = cont
                            return false
                        }
                        if resumeImmediately {
                            cont.resume()
                        }
                    }
                    return true
                }

                group.addTask {
                    try? await Task.sleep(nanoseconds: timeoutNs)
                    return false
                }

                let result = await group.next() ?? false
                group.cancelAll()
                return result
            }
        }

        let watcher = CanvasFileWatcher(url: dir) {
            fired.withLock { $0 = true }
            let cont = waitState.withLock { state in
                state.fired = true
                let cont = state.cont
                state.cont = nil
                return cont
            }
            cont?.resume()
        }
        watcher.start()
        defer { watcher.stop() }

        // Give the stream a moment to start.
        try await Task.sleep(nanoseconds: 150 * 1_000_000)

        // Modify the file in-place (no rename). This used to be missed when only watching the directory vnode.
        let handle = try FileHandle(forUpdating: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(" world".utf8))
        try handle.close()

        let ok = await waitForFire(timeoutNs: 2_000_000_000)
        #expect(ok == true)
        #expect(fired.withLock { $0 } == true)
    }
}
