// Carriot.app: the carriot dashboard in its own window, with a Dock icon and a carriot:// URL scheme.
// Built and installed by `carriot app install`; `carriot open` sends carriot://focus/<session id> to it.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  private var window: NSWindow?
  private var web: WKWebView?
  private var loaded = false
  private var pendingFocus: String?
  private var failures = 0

  private let info = Bundle.main.infoDictionary ?? [:]
  private var port: String { ProcessInfo.processInfo.environment["CARRIOT_PORT"] ?? (info["CarriotPort"] as? String) ?? "7777" }
  private var carriot: String { (info["CarriotBin"] as? String) ?? "carriot" }
  private var base: String { "http://127.0.0.1:\(port)/" }

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    web.navigationDelegate = self
    web.uiDelegate = self
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Carriot"
    window.contentView = web
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("CarriotDashboard")
    if !window.setFrameUsingName("CarriotDashboard") { window.center() }
    self.web = web
    self.window = window
    show()
    startServerThenLoad()
  }

  /// Closing the window keeps Carriot running, like Mail; clicking the Dock icon brings it back.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    show()
    return true
  }

  /// carriot://focus/<session id> brings the window forward on that session; carriot://open just brings it forward.
  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls where url.scheme == "carriot" {
      focus(url.host == "focus" ? url.pathComponents.dropFirst().first : nil)
    }
  }

  private func show() {
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func focus(_ id: String?) {
    show()
    guard let id else { return }
    let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" }
    guard !safe.isEmpty else { return }
    if loaded, let web {
      web.evaluateJavaScript("location.hash = '\(safe)'")
    } else {
      pendingFocus = safe
    }
  }

  /// `carriot open --server-only` starts the dashboard server in the background unless it already runs.
  private func startServerThenLoad() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", "\"$0\" open --server-only", carriot]
    process.terminationHandler = { _ in DispatchQueue.main.async { self.load() } }
    do { try process.run() } catch { load() }
  }

  private func load() {
    let target = pendingFocus.map { "\(base)#\($0)" } ?? base
    pendingFocus = nil
    if let url = URL(string: target) { web?.load(URLRequest(url: url)) }
  }

  @objc private func reload() {
    if loaded { web?.reload() } else { load() }
  }

  // MARK: navigation

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded = true
    failures = 0
    if let id = pendingFocus {
      pendingFocus = nil
      webView.evaluateJavaScript("location.hash = '\(id)'")
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    retry()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    retry()
  }

  /// The server is down or restarting: try again with a growing delay, and every few attempts start it again.
  private func retry() {
    loaded = false
    failures += 1
    let delay = min(Double(failures), 5)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      if self.failures % 4 == 0 { self.startServerThenLoad() } else { self.load() }
    }
  }

  /// PR, ticket and other outside links open in the default browser; only the dashboard stays in this window.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if let url = action.request.url, ["http", "https"].contains(url.scheme ?? ""),
      !["127.0.0.1", "localhost"].contains(url.host ?? "")
    {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  // MARK: menu (Edit is what makes copy and paste work in the reply box)

  private func buildMenu() {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let item = NSMenuItem()
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      item.submenu = menu
      main.addItem(item)
    }
    func item(_ title: String, _ action: Selector, _ key: String, target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.target = target
      return i
    }
    submenu("Carriot", [
      item("Hide Carriot", #selector(NSApplication.hide(_:)), "h"),
      .separator(),
      item("Quit Carriot", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "Z"),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    submenu("View", [item("Reload", #selector(reload), "r", target: self)])
    submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
