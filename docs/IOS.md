# Putting NFrame Studio on an iPhone

Android can install an APK a browser downloaded. An iPhone cannot install
anything that way, so the only route outside the App Store is **Ad Hoc**
distribution: a build signed for a specific list of iPhones, handed to Apple's
own installer through an `itms-services:` link.

That means two things are true no matter how the build is made:

- It needs a paid **Apple Developer Program** membership ($99/year).
- It only installs on iPhones whose **device identifier (UDID)** was registered
  before the build was signed. Any other iPhone says "Unable to Install" and
  gives no reason.

The update channel is already built and tested. What follows is the part that
has to happen on a Mac.

## 1. Does it even compile? (free, no Apple account)

Nothing in this app has ever been built for iOS. Find out before paying anyone.

```bash
# Xcode from the App Store, then its command line tools
xcode-select --install
sudo xcodebuild -license accept

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
bun install
bunx tauri ios init
```

`tauri ios init` writes `src-tauri/gen/apple`, the Xcode project. Then run it on
the simulator, which needs no signing and no account:

```bash
bunx tauri ios dev --open    # opens Xcode; pick an iPhone simulator and run
```

Expect trouble here rather than a clean first run. The app is a Rust RAW engine
with WebGL2 and ONNX models, and iOS is the least travelled of Tauri's targets.
Send me whatever it prints and I will work through it.

## 2. Register the iPhone

Its UDID, not its name:

- Plug it into the Mac, open **Finder**, select the iPhone in the sidebar, and
  click the line under its name until the identifier appears. Right-click to
  copy it.
- Add it at <https://developer.apple.com/account/resources/devices/list>.

Every iPhone that is to run the app has to be on this list, up to 100. Adding
one later means signing and publishing a new build - an existing one will not
pick it up.

## 3. Signing

In the Apple Developer account:

- An **App ID** for `com.nvisi.darkroom`. It has to be this exactly: it is what
  the install manifest names, and iOS matches on it.
- An **Ad Hoc provisioning profile** for that App ID, with the registered
  devices ticked.
- An **Apple Distribution** certificate, in the Mac's keychain.

## 4. Build the .ipa

```bash
bunx tauri ios build --export-method ad-hoc
```

The .ipa lands under `src-tauri/gen/apple/build/`. Upload it to the release for
the version it was built from, exactly as the Android APK is:

```bash
gh release upload v0.2.27 "path/to/NFrame Studio.ipa" --clobber
```

## 5. Installing it

The update proxy does the rest, and needs no change per release:

| URL | What it is |
| --- | --- |
| `https://updates.nvisionfilms.com/darkroom/ios.json` | what the app's own update check reads |
| `https://updates.nvisionfilms.com/darkroom/ios-manifest.plist` | what Apple's installer reads |

Both are generated from the newest release carrying an `.ipa`, so publishing a
build is all it takes. To install the first copy, open this on the iPhone **in
Safari** - not in another browser, and not from a chat app's own viewer:

```
itms-services://?action=download-manifest&url=https%3A%2F%2Fupdates.nvisionfilms.com%2Fdarkroom%2Fios-manifest.plist
```

Then **Settings > General > VPN & Device Management**, and trust the developer.
After that first install, the app checks for itself and offers the update the
same way the Android build does.

## What stays awkward

- **The profile expires after a year.** When it does, the installed app stops
  launching until a build signed with a fresh profile is installed. Nothing
  warns you first.
- **Adding an iPhone needs a new build.** The device list is baked into the
  signature.
- **CI cannot do this yet.** The Android APK is already built by hand here
  because the signing secrets are not in the repo; iOS would be the same until
  the certificate and profile are added as secrets.
