import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where `carriot app install` puts the app; `carriot open` uses it whenever it exists. */
export const APP_PATH = join(homedir(), "Applications", "Carriot.app");
const BUNDLE_ID = "local.carriot.dashboard";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export const appInstalled = () => existsSync(APP_PATH);

function plist(carriotBin: string, port: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Carriot</string>
  <key>CFBundleDisplayName</key><string>Carriot</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>Carriot</string>
  <key>CFBundleIconFile</key><string>carriot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
      <key>CFBundleURLSchemes</key><array><string>carriot</string></array>
    </dict>
  </array>
  <key>CarriotBin</key><string>${esc(carriotBin)}</string>
  <key>CarriotPort</key><string>${esc(port)}</string>
</dict>
</plist>
`;
}

function run(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${p.stderr.toString().trim() || p.stdout.toString().trim()}`);
}

/** Compiles app/Carriot.swift with swiftc and assembles a signed Carriot.app at `bundle`. */
export function buildBundle(bundle: string, port: string, carriotBin = realpathSync(join(import.meta.dir, "../../../bin/carriot"))) {
  const dir = import.meta.dir;
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents/Resources"), { recursive: true });
  run([
    "xcrun", "swiftc", "-O", "-swift-version", "5",
    "-o", join(bundle, "Contents/MacOS/Carriot"),
    join(dir, "../app/Carriot.swift"),
    "-framework", "Cocoa", "-framework", "WebKit",
  ]);
  copyFileSync(join(dir, "../assets/icon.icns"), join(bundle, "Contents/Resources/carriot.icns"));
  writeFileSync(join(bundle, "Contents/Info.plist"), plist(carriotBin, port));
  run(["codesign", "--force", "--sign", "-", bundle]);
}

/** Builds Carriot.app, moves it into ~/Applications and registers it (and its carriot:// scheme) with Launch Services. */
export function installApp(port: string): string {
  const work = mkdtempSync(join(tmpdir(), "carriot-app-"));
  try {
    const bundle = join(work, "Carriot.app");
    buildBundle(bundle, port);
    mkdirSync(join(homedir(), "Applications"), { recursive: true });
    rmSync(APP_PATH, { recursive: true, force: true });
    renameSync(bundle, APP_PATH);
    run([LSREGISTER, "-f", APP_PATH]);
    return APP_PATH;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
