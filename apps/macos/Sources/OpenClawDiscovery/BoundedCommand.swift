import Foundation
import Subprocess

enum BoundedCommand {
    private static let defaultOutputLimit = 8 * 1024 * 1024

    static func run(
        path: String,
        arguments: [String],
        environment: [String: String]? = nil,
        timeout: TimeInterval,
        outputLimit: Int = defaultOutputLimit) async -> String?
    {
        guard timeout > 0, outputLimit > 0 else { return nil }

        let executable: Executable = path.contains("/")
            ? .path(.init(path))
            : .name(path)
        let subprocessEnvironment = environment.map(self.environment(from:)) ?? .inherit

        do {
            return try await withThrowingTaskGroup(
                of: String?.self,
                returning: String?.self)
            { group in
                group.addTask {
                    let result = try await Subprocess.run(
                        executable,
                        arguments: Arguments(arguments),
                        environment: subprocessEnvironment,
                        output: .string(limit: outputLimit))
                    guard result.terminationStatus.isSuccess,
                          let output = result.standardOutput?
                              .trimmingCharacters(in: .whitespacesAndNewlines),
                              !output.isEmpty
                    else {
                        return nil
                    }
                    return output
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    return nil
                }

                // Keep timeout structured so swift-subprocess kills and reaps a canceled
                // child before callers can start the next discovery probe.
                defer { group.cancelAll() }
                guard let result = try await group.next() else {
                    return nil
                }
                return result
            }
        } catch {
            return nil
        }
    }

    private static func environment(from values: [String: String]) -> Environment {
        var converted: [Environment.Key: String] = [:]
        converted.reserveCapacity(values.count)
        for (key, value) in values {
            guard let environmentKey = Environment.Key(rawValue: key) else { continue }
            converted[environmentKey] = value
        }
        return .custom(converted)
    }
}
