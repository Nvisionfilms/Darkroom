# Darkroom on phones

The phone apps are the same Tauri app as the desktop, with a phone layout that
switches on for phone-sized screens (`src/phone.ts`). Tablets keep the desktop
layout. Work lives on the `mobile` branch.

What changes on a phone:

- **Layout.** Photo on top, tool tabs along the bottom, one sheet of controls at
  a time, a photo library screen instead of the filmstrip. Pinch to zoom,
  double-tap to fit, hold ◧ in the top bar to see the original.
- **Opening photos.** Phones hand the app a handle, not a file path, and the app
  may not write next to your photos. Each photo you pick is copied into
  Darkroom's own storage (`src-tauri/src/import.rs`); its edits are saved next to
  that copy, and picking the same photo again brings them back.
- **Exporting.** The export is rendered into app storage, then written to
  wherever you chose in the save sheet.
- **Switched off.** In-app updates (the app stores do that), tethered capture and
  the phone monitor.

## iPhone (build on the Mac)

iOS apps can only be built on a Mac with Xcode.

### One-time setup

1. **Xcode** from the App Store. Open it once and let it install the iOS
   platform, then in Terminal:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   ```

2. **Your Apple ID in Xcode:** Xcode > Settings > Accounts > **+** > Apple ID.
   Select it, click **Manage Certificates**, then **+** > **Apple Development**.
   A free Apple ID works; see the note on free accounts below.

3. **Tools** (Rust and bun are already on the Mac from the desktop builds):

   ```bash
   brew install cocoapods
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
   ```

4. **The code:**

   ```bash
   cd ~/Darkroom
   git status            # should be clean; commit or stash anything first
   git fetch origin
   git checkout mobile
   bun install
   ```

5. **Generate the Xcode project:**

   ```bash
   bun tauri ios init
   ```

   It looks for your signing team and asks you to pick one if there is more
   than one. If it says no team was found, give it yours and run it again:

   ```bash
   export APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX
   ```

   The ID is in Keychain Access: open your "Apple Development" certificate,
   Get Info, and read **Organizational Unit**.

6. **The iPhone:** plug it into the Mac, unlock it and tap **Trust**. Then on the
   phone turn on **Settings > Privacy & Security > Developer Mode** (it only
   appears after the phone has been connected to Xcode once) and let it restart.

### Build and install

```bash
bun tauri ios run
```

This builds a standalone app and installs it on the connected iPhone. The first
time, iOS will refuse to open it until you trust yourself: **Settings > General >
VPN & Device Management >** your Apple ID **> Trust**.

While working on the app, `bun tauri ios dev` does the same but loads the
interface from the Mac, so changes show up without a rebuild. The phone and Mac
need to be on the same Wi-Fi.

### Free Apple ID vs paid developer account

- **Free Apple ID:** installs on your own iPhone only, and the app stops opening
  after **7 days**. Plug in and run `bun tauri ios run` again to renew it.
- **Apple Developer Program ($99/year):** apps last a year, and TestFlight can
  put it on other people's phones.

### Things to know on iPhone

- **HEIC photos don't open yet.** The iPhone camera saves HEIC by default. Set
  **Settings > Camera > Formats > Most Compatible** to shoot JPEG, or open RAW
  files (ProRAW DNG, or camera RAWs copied into Files). Darkroom tells you this if
  you pick a HEIC.
- **Not yet tried on an iPhone GPU.** The preview needs WebGL2 with float
  render targets. It works on Android; if the photo area stays black on the
  iPhone, that is the first thing to check.

## Android (build on Windows)

Needs Android Studio with the SDK and NDK installed.

```bash
export NDK_HOME="$LOCALAPPDATA/Android/Sdk/ndk/26.1.10909125"
bun tauri android build --debug --apk --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

With USB debugging on and the phone plugged in, `bun tauri android run` builds
and installs in one step. A debug build is large (hundreds of MB of debug
symbols); a release build is far smaller but has to be signed.
