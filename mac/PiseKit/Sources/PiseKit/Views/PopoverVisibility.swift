import AppKit
import SwiftUI

// MenuBarExtra can retain its SwiftUI content between openings. Observe the
// actual hosting window instead of treating onAppear as an open/close signal.
struct PopoverVisibility: NSViewRepresentable {
    let onChange: @MainActor @Sendable (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        let coordinator = context.coordinator
        view.didMove = { window in coordinator.observe(window) }
        return view
    }

    func updateNSView(_ nsView: ProbeView, context: Context) {}

    static func dismantleNSView(_ nsView: ProbeView, coordinator: Coordinator) {
        coordinator.stopObserving()
    }

    @MainActor final class Coordinator {
        let onChange: @MainActor @Sendable (Bool) -> Void
        var observation: NSKeyValueObservation?
        private weak var window: NSWindow?
        private var generation = 0

        init(onChange: @escaping @MainActor @Sendable (Bool) -> Void) { self.onChange = onChange }

        func observe(_ window: NSWindow?) {
            invalidate()
            self.window = window
            guard let window else { onChange(false); return }
            let ticket = generation
            observation = window.observe(\.isVisible, options: [.initial, .new]) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self, self.generation == ticket else { return }
                    // Read the current value on the main actor, not a historical
                    // notification that can arrive after a later close/reopen.
                    self.onChange(self.window?.isVisible ?? false)
                }
            }
        }

        func stopObserving() {
            invalidate()
            onChange(false)
        }

        private func invalidate() {
            generation += 1
            observation?.invalidate()
            observation = nil
            window = nil
        }
    }

    @MainActor final class ProbeView: NSView {
        var didMove: (@MainActor (NSWindow?) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            didMove?(window)
        }
    }
}
