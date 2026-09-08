import Foundation
import OpenClawIPC

func readMacControlSecret(_ source: MacControlOptions.SecretSource?) throws -> String? {
    guard let source else { return nil }
    let handle: FileHandle
    switch source {
    case .stdin: handle = .standardInput
    case let .file(path):
        guard let file = FileHandle(forReadingAtPath: NSString(string: path).expandingTildeInPath) else {
            throw MacControlOptions.usage("Could not read the secret file.")
        }
        handle = file
    }
    defer { if source != .stdin { try? handle.close() } }
    var data = Data()
    do {
        while data.count <= MacControlCredentials.maximumFrameBytes {
            let remaining = MacControlCredentials.maximumFrameBytes + 1 - data.count
            let chunk = try handle.read(upToCount: min(4096, remaining)) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk)
        }
    } catch {
        throw MacControlOptions.usage("Could not read the secret input.")
    }
    guard data.count <= MacControlCredentials.maximumFrameBytes, var value = String(data: data, encoding: .utf8) else {
        throw MacControlOptions.usage("Secret input must be bounded UTF-8 text.")
    }
    while value.last == "\n" || value.last == "\r" {
        value.removeLast()
    }
    guard !value.isEmpty else { throw MacControlOptions.usage("Secret input is empty.") }
    return value
}
