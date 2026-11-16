# GozarVpn

A censorship-circumvention client for **Windows** and **Android**, with several engines behind one simple interface:

- **Aether** (Cloudflare WARP / MASQUE)
- **V2ray / Xray** links and subscriptions (VLESS, VMess, Trojan, Shadowsocks, WireGuard) via sing-box
- **AmneziaWG** `.conf` files (via wireproxy-awg)
- **Clash / mihomo** profiles
- **Tor** (bridges, your own bridges, or Tor over WARP)
- **Psiphon** (via Aether or on its own)
- **OpenVPN** `.ovpn` files (the official OpenVPN client, run as a separate program)

Features: real ping test, live speed/ping/exit-IP stats, smart anti-DPI for TLS servers, automatic
server choice with failover, **Iran-direct routing** (Iranian sites and IPs skip the tunnel),
always-direct apps and per-app split tunnelling (Android), pause / auto-pause for apps that refuse
to run with a VPN, a **kill switch** (blackhole TUN on Android, Windows Firewall rules on Windows),
system proxy or TUN mode (Windows), and in-app updates from this repository's Releases (checked
against `SHA256SUMS.txt`).

| Folder | What |
|---|---|
| `desktop/` | Windows app (Electron) |
| `android/` | Android app (Kotlin, Jetpack Compose, VpnService) |

## Download

See **Releases**. Windows: `GozarVpn-Setup-x.y.z.exe` (installer) or `GozarVpn-Portable-x.y.z.exe`.
Android APKs come per CPU: `arm64-v8a` (ARMv8 64-bit, almost every phone since ~2017, recommended),
`armeabi-v7a` (ARMv7 32-bit, old phones) and `universal` (both, largest). Every release has a
`SHA256SUMS.txt`. Persian guide: [README.fa.md](README.fa.md).

## Building

- **Windows:** Node.js 20+, then in `desktop/`: `npm ci` and `npx electron-builder --win`.
  The Windows app downloads the engines it needs from their official releases at run time.
- **Android:** JDK 21, Android SDK 36 and NDK 28.2, then in `android/`: `gradle assembleDebug`.
  Release signing reads a `keystore.properties` file you point `GOZAR_KEYSTORE_PROPS` at (not part of
  this repository). The engine binaries are not stored in git: put them in
  `android/app/src/main/jniLibs/<abi>/` and `android/app/libs/` as listed, with their SHA-256 and
  build scripts, in [BINARIES.md](BINARIES.md).

## License and sources

GozarVpn is released under the **GNU AGPL-3.0** ([LICENSE](LICENSE)), because it bundles Aether
(AGPL-3.0). The engines are separate open-source programs with their own licenses (GPL-2.0, GPL-3.0,
AGPL-3.0, BSD-3-Clause, ISC…); the license texts ship inside the apps
(`android/app/src/main/assets/licenses/`, `desktop/resources/*/LICENSE.txt`).

**Corresponding source:** [BINARIES.md](BINARIES.md) names, for every bundled binary, the exact
upstream project, version or commit and SHA-256, and how it was built. The complete source of each
is available from that upstream project at that version; if any of it ever becomes unavailable,
open an issue and we will provide it.

"Aether", "OpenVPN", "Tor" and "Psiphon" are names of the upstream projects, used only to say
which engine is running; GozarVpn is not affiliated with them.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
