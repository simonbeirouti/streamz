# Streamz

Streamz is a desktop creator studio built with React, Tauri v2, and OBS
Studio. It gives creators a focused interface for composing scenes, managing
sources and audio, previewing the program output, recording, replay buffering,
and broadcasting to Kick.

OBS Studio 32.2.1 is the media engine. Streamz launches and controls it over a
private, loopback-only OBS WebSocket session; creators do not need to configure
OBS WebSocket themselves.

## Current state

The app currently supports:

- macOS 13+ on Apple Silicon for the complete packaged installer flow
- Windows x64 runtime preparation and development support
- scenes, sources, transforms, filters, audio, media, and Studio Mode
- in-app program preview using OBS Virtual Camera, with snapshot preview as a
  fallback
- Kick broadcasting through a custom RTMPS server and ephemeral stream key
- local recording and Replay Buffer controls
- opening native OBS as an advanced escape hatch

See [the OBS parity matrix](docs/OBS_PARITY_MATRIX.md) for the implemented OBS
request, state, event, and failure behavior behind each control.

## Prerequisites

Install:

- Node.js 20 or newer
- pnpm 10
- Rust and Cargo through [rustup](https://rustup.rs/)
- the platform prerequisites for
  [Tauri v2](https://v2.tauri.app/start/prerequisites/)

On macOS, install the Xcode Command Line Tools:

```sh
xcode-select --install
```

For a working in-app video preview on macOS, also install the official signed
OBS Studio app in `/Applications`. The production installer described below
does this for the user.

## Get up and running

Install dependencies:

```sh
pnpm install
```

Start the desktop app:

```sh
pnpm tauri dev
```

Use the Tauri command rather than `pnpm dev`: the plain Vite server does not
provide the native process management used to launch OBS.

The first run downloads the pinned official OBS Studio 32.2.1 build, verifies
its SHA-256 checksum, and stages it in `src-tauri/resources/obs/`. This is
roughly a 180 MB one-time download. The download cache (`.obs-cache/`) and
staged runtime are intentionally excluded from Git. Later runs skip preparation
while the verified runtime is present.

When Streamz opens, it launches OBS in the background, creates an isolated
Streamz session profile, assigns a random WebSocket password and free local
port, then connects automatically. Streamz restores OBS's previous WebSocket
setting and removes temporary stream credentials when the session ends.

### Useful commands

```sh
pnpm check                 # TypeScript type-check
pnpm test                  # Run the Vitest suite
pnpm build                 # Build the web frontend
pnpm tauri build           # Build the desktop app
pnpm obs:prepare           # Re-stage OBS for the current platform
pnpm obs:prepare:macos     # Prepare the macOS Apple Silicon runtime
pnpm obs:prepare:windows   # Prepare the Windows x64 runtime
```

To prepare Windows resources from macOS before making a cross-platform bundle:

```sh
pnpm obs:prepare:windows
```

## Getting video connected

OBS control, recording, and streaming work with the staged runtime. Smooth
in-app video is a separate concern: Streamz starts OBS Virtual Camera and opens
it as a local camera device. If that device is unavailable, Streamz falls back
to periodic OBS program screenshots.

### macOS

Apple only activates the OBS Camera Extension for the official signed
`OBS.app` installed in `/Applications`. A copied or nested OBS runtime can
still stream and accept WebSocket commands, but it cannot provide Virtual
Camera.

For local development:

1. Install the official OBS Studio app as `/Applications/OBS.app`.
2. Open OBS once and click **Start Virtual Camera**.
3. Approve OBS in **System Settings → Privacy & Security → Extensions**. On
   some macOS versions this appears under **Login Items & Extensions → Camera
   Extensions**.
4. Restart OBS and Streamz.
5. Approve camera access for Streamz when macOS asks.

Streamz automatically prefers `/Applications/OBS.app` over the staged copy
when it is available. If preview still uses snapshots, confirm that **OBS
Virtual Camera** appears as a camera in another app, then restart Streamz.

### Windows

Launch Streamz first, then use its Virtual Camera setup action. Approve the
administrator prompt from the bundled OBS installer and restart OBS/Streamz.
Camera permission must also be enabled for desktop apps in Windows Settings.

## Publishing to Kick

1. Add and arrange the camera, microphone, display, or other sources in
   Streamz.
2. Check the program preview and audio meters.
3. Open the Kick streaming dashboard from the **Go live** dialog and copy the
   channel's RTMPS server and stream key.
4. Paste both values into Streamz and choose **Start broadcast**.
5. Stop the broadcast from Streamz when finished.

The stream key remains in memory for the active session. Streamz clears it from
its OBS session profile when streaming stops or the session is cleaned up; it
is not stored by the app. Treat the key as a secret and reset it in Kick if it
is ever exposed.

The current output preset is 1920×1080, 30 fps, x264 video at 6000 Kbps, and
stereo audio at 160 Kbps/48 kHz. Validate these values against the current
requirements for the destination before a production broadcast.

## Publishing the macOS installer

The macOS release is deliberately a two-app installer. It installs
`Streamz.app` and the untouched, officially signed `OBS.app` side by side in
`/Applications`. Keeping OBS separate preserves its signature and allows macOS
to activate its Camera Extension, which is required for connected in-app video.

Build the Apple Silicon package:

```sh
pnpm package:macos
```

The script:

- builds the Streamz `.app` without embedding OBS
- downloads and checksum-verifies the pinned official OBS disk image
- verifies the OBS code signature
- packages both apps for `/Applications`
- checks that neither installer component is relocatable
- signs and notarizes the package when release credentials are configured

The result is written to:

```text
src-tauri/target/release/bundle/pkg/Streamz_<version>_aarch64.pkg
```

Without Apple certificates, the command creates an unsigned package suitable
only for local testing. For a distributable build, set:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: …"
export APPLE_INSTALLER_SIGNING_IDENTITY="Developer ID Installer: …"
export STREAMZ_NOTARY_PROFILE="streamz-notary"
pnpm package:macos
```

`STREAMZ_NOTARY_PROFILE` must name a `notarytool` keychain profile created
beforehand, for example:

```sh
xcrun notarytool store-credentials streamz-notary \
  --apple-id "developer@example.com" \
  --team-id "TEAMID" \
  --password "app-specific-password"
```

When the profile is present, packaging submits the `.pkg`, waits for Apple's
result, and staples the notarization ticket. Before publishing, update the app
version consistently in `package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml`, then verify the final artifact:

```sh
pkgutil --check-signature \
  src-tauri/target/release/bundle/pkg/Streamz_<version>_aarch64.pkg
spctl --assess --type install --verbose \
  src-tauri/target/release/bundle/pkg/Streamz_<version>_aarch64.pkg
```

Install and test the exact packaged artifact on a clean Mac. Confirm that both
apps land in `/Applications`, approve the OBS Camera Extension once, and verify
preview, recording, and a private/test broadcast before distributing it.

## Troubleshooting

**OBS preparation fails**

Check network access and retry `pnpm obs:prepare`. A partial or
checksum-mismatched download is rejected rather than staged.

**Streamz does not connect to OBS**

Quit both Streamz and OBS, then restart with `pnpm tauri dev`. Streamz uses a
random loopback port, so no fixed OBS WebSocket port or password is required.

**The preview is updating slowly**

Streamz is using screenshot fallback because OBS Virtual Camera is unavailable.
Follow the platform setup under **Getting video connected**.

**The camera or microphone is missing**

Grant camera/microphone permission to Streamz and OBS in system settings,
restart both apps, and add the source again. Native OBS can be opened from
Streamz for advanced device properties.

**The macOS package installs but video will not connect**

Confirm that OBS is exactly `/Applications/OBS.app`, open it once, enable its
Camera Extension in System Settings, and restart it. A locally staged OBS copy
cannot activate that extension.
