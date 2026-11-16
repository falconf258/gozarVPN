# Engine binaries

GozarVpn's own code is in this repository. The connection engines are separate open-source
projects; their binaries are not stored in git but ship inside the release files. To build from
source, put these exact files in place (check the SHA-256).

## Android CPU types (ABIs)

| APK | CPU | For |
|---|---|---|
| `GozarVpn-x.y.z-arm64-v8a-release.apk` | ARMv8, 64-bit | almost every phone made since ~2017 (recommended) |
| `GozarVpn-x.y.z-armeabi-v7a-release.apk` | ARMv7, 32-bit | old phones |
| `GozarVpn-x.y.z-universal-release.apk` | both | works on either; the largest file |

## Android (`android/app/...`, arm64-v8a)

| File | Source | SHA-256 |
|---|---|---|
| `libs/libbox.aar` (arm64-v8a + armeabi-v7a) | sing-box v1.14.4 (GPL-3.0), built with gomobile: `android/tools/bind-libbox.cmd` | `D7A01893922828806F4D6E969D9DF6B49438BC821968B8CDAF42EC63395EA345` |
| `src/main/jniLibs/arm64-v8a/libaether.so` | Aether v2.4.0 (AGPL-3.0), `aether` from the official `aether-android-arm64.tar.gz` | `1C36661A7B06D79F9B5CAEAEFC68A50D33D47BFE437AC082E699498A5B326C13` |
| `src/main/jniLibs/arm64-v8a/libtor.so` | Tor Expert Bundle 15.0.25, android-aarch64 (Tor Project) | `73A99287BAB545900B9FA41CCBD3ECD1E5B8FBB0D73ADE849AEEC390CBC9B2BB` |
| `src/main/jniLibs/arm64-v8a/liblyrebird.so` | lyrebird from the same Tor Expert Bundle | `7EABF4EC5A1A1DEA6AB30E444E209A73A89AED5D46E204848352A242D52BDDB6` |
| `src/main/jniLibs/arm64-v8a/libmihomo.so` | mihomo v1.19.33 (GPL-3.0), android arm64 release | `CFA0BE78846BFEF7272FE5A73089F8CF0E1F15A6FFB601F5CC809F457F712F67` |
| `src/main/jniLibs/arm64-v8a/libpsiphon.so` | psiphon-tunnel-core (GPL-3.0), CluvexStudio fork commit `83aa73b9`, built with Go 1.26.3: `android/tools/build-psiphon.cmd` | `90E5CFA63A84683CD5DE7959DDCE2590112AC6A071462BA332BABA2A9E9E0479` |

## Android armeabi-v7a (`android/app/src/main/jniLibs/armeabi-v7a/`)

Downloaded by `android/tools/fetch-armv7.js` from the official releases, each checked against the publisher's SHA-256.

| File | Source | SHA-256 |
|---|---|---|
| `libaether.so` | `aether` from Aether v2.4.0 `aether-android-armv7.tar.gz` | `91C984E44C0084592C82B3727076CE263248D293F3E7E2F20F01D1A98F2191DC` |
| `libpsiphon.so` | `pt/psiphon-tunnel-core` from the same Aether archive | `719BF754D197ECB2B320E6251ACE79109DC1972C6675206950BF8CB5A55F03CA` |
| `libtor.so` | `tor/libTor.so` from Tor Expert Bundle 15.0.25 android-armv7 | `77378E97FE83F9436895BE82D380B466020F05F98638DBCAA356C006AACACAD1` |
| `liblyrebird.so` | `tor/pluggable_transports/lyrebird` from the same bundle | `532C5545F3E05A5EFB98B1215D2804FDCC703D8608C16FFBBD1CB9C66CA83032` |
| `libmihomo.so` | mihomo v1.19.33 `mihomo-android-armv7-v1.19.33.gz` | `2FBF5E623A6B7B095768BFAB1E7F48180045B7BD6B67E36DAF8423F81272BEDB` |

## Windows (`desktop/resources/...`)

| File | Source | SHA-256 |
|---|---|---|
| `psiphon/psiphon-tunnel-core.exe` | same fork and commit, Go 1.26.3, `desktop/scripts/build-psiphon-win.cmd`; identical to `pt/psiphon-tunnel-core.exe` in the official Aether v2.4.0 Windows zip | `A6FC6094E169B61EED5FB51F7267A8EE2C648765C3E1C9A6CD88AFFE63AB4F29` |

The Windows app downloads the other engines itself (Aether, sing-box, mihomo, Tor) from their
official releases and checks their published SHA-256.

The build scripts read `GOZAR_SRC` (folder for the upstream sources) and `GOZAR_ENV` (optional script that puts the toolchains on PATH).
Licenses of every bundled engine are in `android/app/src/main/assets/licenses/` and `desktop/LICENSE`.
## Iran routing rules

`android/app/src/main/assets/rules/` and `desktop/resources/rules/` hold `geosite-ir.srs` / `geoip-ir.srs` from [Chocolate4U/Iran-sing-box-rules](https://github.com/Chocolate4U/Iran-sing-box-rules) (GPL-3.0, `rule-set` branch), plus `geosite-ir.txt`, the same domain list as text for the in-app tester. The apps can update the `.srs` files from the jsDelivr mirror of that branch.

## AmneziaWG engine

wireproxy-awg (ISC), [artem-russkikh/wireproxy-awg](https://github.com/artem-russkikh/wireproxy-awg) commit `84f4795ea76f9c3168a61e478d0fe0e5c3238308`, built with Go 1.26.3, `CGO_ENABLED=0` (`android/tools/build-awg.cmd`).

| File | SHA-256 |
|---|---|
| `desktop/resources/awg/awg-proxy.exe` (windows/amd64) | `1F14B74142FD30FFDBC523D9B79A3C359854C38A8D1899B27B4456EF449CFC94` |
| `android/.../jniLibs/arm64-v8a/libawg.so` | `39E519DA2A1639A6FC79E44CC31F305715F78C0D8EEB7D1FE176B6225644D8FA` |
| `android/.../jniLibs/armeabi-v7a/libawg.so` | `A4D7C824FA79E1B1765B28A9F5C185877DE4D9CB81592C8382DE01092EF3FB3B` |

## OpenVPN engine

OpenVPN is GPL-2.0 (with an OpenSSL linking exception). GozarVpn only runs it as a separate
program and talks to it over its management socket; none of its code is linked into the app.

**Windows:** nothing is bundled. The app uses the official OpenVPN Community installation
(`openvpn.exe` and its network drivers). Its "install" button downloads
`https://swupdate.openvpn.org/community/releases/OpenVPN-2.7.9-I001-amd64.msi` and runs it only
if the file carries a valid Authenticode signature from OpenVPN Inc.

**Android:** the OpenVPN 2 client from [schwabe/ics-openvpn](https://github.com/schwabe/ics-openvpn)
tag `v0.7.69` (commit `f669267e2547fddca04d0bc699739137085eb633`), whose `openvpn` submodule is at
`c29ee42e48df0de5993f7b256829196e67e76006` (OpenVPN 2.8 development branch), with the
submodules at the commits that tag pins (OpenSSL, LZO, LZ4). Built in ics-openvpn's own "skeleton" configuration (OpenVPN 2 only, no OpenVPN 3) with `-ffile-prefix-map` so no build paths are embedded, then stripped. Only the native targets `openvpn`
and `libovpnexec.so` are built, with NDK 28.2 (`android/tools/build-openvpn-android.cmd`). The
complete corresponding source is that tag with its submodules. Licences:
`assets/licenses/openvpn-COPYING.txt` and `assets/licenses/ics-openvpn-LICENSE.txt`.

| File | SHA-256 |
|---|---|
| `android/.../jniLibs/arm64-v8a/libovpnexec.so` | `BD0BBE4F2D3269B8F53124234C66FF4D9344889BA3DD972A47648A9257036C73` |
| `android/.../jniLibs/arm64-v8a/libopenvpn.so` | `67EC56578814720E2E76E323D5BADBAB847B7A36AC168061BB8B9AEAD746055F` |
| `android/.../jniLibs/armeabi-v7a/libovpnexec.so` | `BDCF9C86C268D72B95AB2F18E5CAC55D69D53C6B6C250CDA33B85F0EF18ADCB9` |
| `android/.../jniLibs/armeabi-v7a/libopenvpn.so` | `AC6E1A1FD899DA63ED9FDC9F9664D0C9D197C73215AAA1006CC689468A4C05E3` |
