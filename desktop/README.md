# Aether GUI (wrapper) — placeholder name, see NOTICE below

A modern Electron GUI (orange/black theme) wrapping the Windows build of the
**Aether** censorship-circumvention core (`aether.exe`). The core itself is
untouched — this app drives it through the exact same environment variables
the official CLI reads (extracted from `aether/src/cli.rs`), streams its logs,
and adds two independent update paths:

1. **Core updates** — checks `CluvexStudio/Aether` GitHub Releases for a new
   `aether-windows-x86_64.zip`, verifies its published SHA-256 checksum,
   and swaps `aether.exe` in place.
2. **App self-update** — `electron-updater` wired to this project's own
   GitHub Releases, so publishing a new tagged build (via the included
   GitHub Actions workflow) reaches every user automatically.

📖 **Full setup, build, and update instructions are in [README.fa.md](README.fa.md)**
(the primary guide — written in Persian since that's the language this project
was commissioned in). Key points if you don't read Persian:

```bash
npm install
npm start          # run in dev — you'll be asked to pick an aether.exe
npm run dist        # build the Windows installer + portable exe (on Windows,
                     # or via the bundled GitHub Actions workflow)
```

## ⚠️ Naming / branding notice

The upstream Aether source ships an AGPL-3.0 `LICENSE` **and** a separate
`TRADEMARK.md` that reserves the "Aether" name and logo — AGPL gives you
rights to the *code*, not the *brand*. This scaffold is named "Aether" only
as a working placeholder. **Rename the app (`package.json` → `name` /
`productName` / `build.appId`, and `src/main/constants.js`) and swap the
icon before distributing this publicly**, unless you've obtained permission
from CluvexStudio.

## License

The core (`aether.exe`) is AGPL-3.0. Since this GUI bundles/downloads that
AGPL binary alongside itself, keeping this wrapper under AGPL-3.0 (or a
compatible license) and publishing its source is the safe default — see
the bundled `LICENSE` file (copied from upstream) for the license text.
