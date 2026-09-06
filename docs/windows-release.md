# Windows release notes

## What the repository currently proves

The GitHub Actions release job successfully builds Windows artifacts. A successful CI build does not prove that every user machine can install the package, so installer failures need to be treated separately from compiler/package failures.

This branch makes the Windows path more deterministic:

- publishes the NSIS `x64-setup.exe` instead of presenting both NSIS and WiX/MSI as equivalent user choices;
- explicitly installs for the current user, which avoids requiring administrator elevation;
- configures updater installs as passive;
- smoke-installs the generated NSIS installer on the Windows GitHub Actions runner and fails the release job if the installer returns a non-zero exit code;
- adds a Windows PR CI job for the frontend and Rust core.

## Important: updater signing is not Windows publisher signing

`TAURI_SIGNING_PRIVATE_KEY` signs updater artifacts so Darkroom can verify updates. It does **not** give the Windows executable a trusted Authenticode publisher identity.

Until Windows code signing is configured, browser-downloaded builds may show Microsoft SmartScreen / unknown-publisher warnings. That is distinct from a broken installer.

## To diagnose a user-machine installation failure

Capture all of the following before changing installer code again:

1. Exact Darkroom version and installer filename.
2. Windows version and architecture.
3. Screenshot or exact error message.
4. Whether Windows SmartScreen appeared before the error.
5. Whether the installer was launched from Downloads, a synced/cloud folder, network drive, or local disk.
6. Whether an older Darkroom build is already installed.

For the NSIS installer, also try a clean current-user installation after uninstalling the previous Darkroom version. Do not delete user photo files or `.drk.json` sidecars while testing.

## Code-signing follow-up

Before a wider public Windows release, configure an Authenticode signing method supported by Tauri (certificate/signing service) and verify the installer signature in CI. Keep updater signing and Authenticode signing as separate release requirements.
