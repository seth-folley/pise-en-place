import AppKit
import ComposableArchitecture

struct ApplicationClient: Sendable {
    var quit: @MainActor @Sendable () -> Void
}

extension ApplicationClient: DependencyKey {
    static let liveValue = Self(quit: { NSApplication.shared.terminate(nil) })
    static let testValue = Self(quit: { reportIssue("ApplicationClient.quit must be overridden in tests") })
    static let previewValue = Self(quit: {})
}

extension DependencyValues {
    var applicationClient: ApplicationClient {
        get { self[ApplicationClient.self] }
        set { self[ApplicationClient.self] = newValue }
    }
}
