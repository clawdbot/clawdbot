import Foundation

enum ThrowingContinuationSupport {
    static func resumeVoid(_ continuation: CheckedContinuation<Void, Error>, error: Error?) {
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume(returning: ())
        }
    }
}
