psiphon-tunnel-core.exe (ConsoleClient), GPL-3.0 - see LICENSE.txt.
Built from source: https://github.com/CluvexStudio/psiphon-tunnel-core branch shirokhorshid, commit 83aa73b9b982e7421e00117f5b0c5aceb5dda452 (the commit Aether v2.4.0 pins).
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 GOFLAGS=-mod=vendor, Go toolchain go1.26.3 as go.mod pins (identical to the official Aether v2.4.0 pt/ binary), go build -trimpath -ldflags "-s -w" ./ConsoleClient
SHA-256: A6FC6094E169B61EED5FB51F7267A8EE2C648765C3E1C9A6CD88AFFE63AB4F29
