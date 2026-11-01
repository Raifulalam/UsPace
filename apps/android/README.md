# Our Space (Android app: website + live wallpaper)

One APK. On launch it shows the **existing Our Space website** (`https://wespc.vercel.app`) in a locked-down WebView, with a small native bar:
**Home** (the website), **Wallpaper** (native: sign this phone in as a device, approval code, "Set as live wallpaper", lock-screen privacy), **Settings** (reload, wallpaper screen, Android app settings).

## Files
- `MainActivity.kt` - WebView host, splash, edge-to-edge, back button, file chooser, error/offline screen, auto-retry on reconnect.
- `WebViewManager.kt` - WebView settings and clients. JS + DOM storage on (the site needs them); no file access; mixed content blocked; SSL errors are never bypassed; camera/mic denied; safe browsing on.
- `TrustPolicy.kt` - only `https://wespc.vercel.app` loads in the WebView. Everything else opens in the system browser (http/https/mailto/tel only); other schemes are dropped. Unit-tested in `TrustPolicyTest`.
- `WebAppBridge.kt` - origin-restricted message channel `OurSpaceNative` (no `addJavascriptInterface`). Exposes no keys/tokens/cookies. Accepts only `openWallpaper` and `saveImage` (PNG).
- `NativeNavigation.kt` - the native bar and settings dialog.
- `WallpaperSetupActivity.kt` - the former `MainActivity`, unchanged apart from the default server address (now the production API) and an https-only check in release builds. Also the live wallpaper's settings page.
- Unchanged: `SyncHub`, `Api`, `Store`, `Crypto`, `CanvasModel`, `CanvasRenderer`, `LoveWallpaperService`.

## Configuration (no URLs hardcoded in code)
`app/build.gradle.kts` defaults: web `https://wespc.vercel.app`, API `https://uspace-ubq2.onrender.com`. Override: `./gradlew assembleDebug -PwebAppUrl=https://... -PapiBaseUrl=https://...`.
Release builds allow no cleartext at all. Debug builds additionally allow `10.0.2.2` and `localhost` (`src/debug/res/xml`).

## Login across vercel.app and onrender.com (implemented)
The API's refresh cookie is `SameSite=Strict`, and `wespc.vercel.app` / `uspace-ubq2.onrender.com` are different sites, so a direct call would lose the session. Fix, with the cookie left strict:
- `apps/web` calls `/api/v1/*` on its own origin when `NEXT_PUBLIC_API_PROXY=1`, and `next.config.mjs` rewrites that to the API. The cookie is then first-party. Sockets still connect straight to the API (Vercel cannot proxy WebSockets) and authenticate with the access token.
- **Vercel env:** `NEXT_PUBLIC_API_URL=https://uspace-ubq2.onrender.com`, `NEXT_PUBLIC_API_PROXY=1`. Redeploy.
- **Render env:** `CLIENT_ORIGIN=https://wespc.vercel.app`, `TRUST_PROXY_HOPS=2` (so rate limits and lockouts see each user's real IP, not Vercel's).
- Watch for: a sleeping Render free instance can take longer than Vercel's proxy timeout on the first request (504). Retry, or keep the instance awake.
- Alternative without a proxy: custom domains `app.you.com` + `api.you.com`.

## Two devices, two approvals
The website inside the WebView is one encrypted device (keys in WebView storage). The live wallpaper is a second device (keys in the Android Keystore). Each is approved separately; manage/revoke both in the website's Security panel.

## PNG download inside the app (implemented)
`LoveCanvas.tsx` now hands the PNG to the app via `OurSpaceNative` when it exists (a `blob:` link cannot be saved in a WebView); ordinary browsers still use the old download path. The app asks where to save it. Needs the Vercel redeploy above.

## Build and test
Open `apps/android` in Android Studio (JDK 17), or `./gradlew assembleDebug` and `./gradlew test`.

## Status: NOT compiled, NOT run
Written without an Android SDK, Gradle or network. Nothing below has been verified on a device: website load, login/logout, back button, canvas and sockets, wallpaper, device approval, offline/reconnect, file upload, keyboard/insets on API < 30, splash/icon. Also unverified: the web changes (not type-checked here, no dependencies installed) and the proxy. Only `TrustPolicy`'s URL rules were checked (with plain Java). Send me build errors and Logcat output and I'll fix them.

---

## Live wallpaper details

Shows the couple's newest canvas as a **live wallpaper**: when your partner draws, strokes appear on this phone as they are drawn.
Android only (iOS does not allow third-party live wallpapers).

## How it fits the encryption model
The phone registers as one more **device** of your account. Your partner (or your other device) approves it with the normal
approval banner in the web app, exactly like any new device. After that the wallpaper downloads its encrypted room-key envelope,
decrypts drawing operations **on the phone**, and draws them. The server never sees drawings.

## Privacy defaults
- **While the phone is locked the wallpaper shows a plain heart**, not the drawing (turn off in the app if you want the drawing on the lock screen).
- Nothing appears until *you* choose it in Android's wallpaper picker; you can switch wallpapers at any time.
- The wallpaper connects only while it is visible on screen, and disconnects shortly after (battery).
- Secrets (device key, room keys, refresh token) are stored in Android Keystore-backed encrypted storage.
- To stop sharing: sign out in the app **and** remove the device in Our Space -> Security -> Devices (this rotates the room key).

## Build and run
1. Install Android Studio (Hedgehog or newer, JDK 17). Open the `apps/android` folder; accept the Gradle sync.
2. Start the API (`apps/api`, `npm run dev`).
3. Emulator (debug build): server address `http://10.0.2.2:4000` (the emulator's name for your PC).
   Real phone: use your PC's LAN address, e.g. `http://192.168.1.20:4000`; allow port 4000 in Windows Firewall; phone and PC on the same Wi-Fi.
   Debug builds allow `http`; release builds require `https`.
4. Run the app, sign in. It shows **"Waiting for approval"** and a 6-group code.
5. In Our Space (web, on a device that already works) a banner appears: *New device "Android live wallpaper (...)"*.
   Check that the **code matches**, then tap **Approve**. The phone's status turns to "Connected".
6. Tap **Set as live wallpaper** and confirm in Android's picker.
7. Open the Live Canvas on the web in another window and draw; the wallpaper updates.

Unit tests (JVM): `./gradlew test`. They run the same shared cases as `packages/canvas-core` (JavaScript) so the two ports cannot drift.

## Status: NOT yet compiled or run
Written without access to an Android SDK. Expect small fixes on first build. The most API-sensitive parts, in order:
1. `Crypto.kt` - calls the C-style libsodium functions of lazysodium's `SodiumAndroid` (`crypto_box_open_easy`, `crypto_aead_xchacha20poly1305_ietf_decrypt`, `crypto_generichash`). If a signature differs, only this file changes.
2. `SyncHub.kt` - uses `IO.Options.builder()...setAuth(...)` from `socket.io-client:2.1.0`.
3. `Store.kt` - `EncryptedSharedPreferences` (security-crypto 1.0.0).
4. Gradle/AGP versions in `build.gradle.kts` (AGP 8.2.2, Kotlin 1.9.22, Gradle 8.5): bump to your Android Studio's recommendation if it asks.
First end-to-end check: after approval the status should reach "Connected". If it stays on "Offline", read Logcat for the failing call.

## Known limits
- Shows the **newest** canvas automatically (follows when a partner starts a new one). No canvas picker yet.
- The wallpaper now **fills the whole screen** (centred, edges cropped): the canvas is landscape (1000x700) and a phone is portrait, so the left/right sides of a drawing are cut off. A small "With <partner name>" label sits near the bottom. It is only drawn together with the drawing, so it is hidden whenever the lock-screen placeholder is shown.
- OEM battery savers may stop the wallpaper process in the background; the wallpaper reconnects when it becomes visible.
- Cloudy cases: a very long stroke previews only its latest ~1,600 points live, then the full stroke appears when committed.
- Android lets users set separate home/lock wallpapers; pick "Home screen" or "Both" in the picker.
