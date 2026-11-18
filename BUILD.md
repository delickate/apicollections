# Building the Windows installer

This produces two files in `dist/`:

- `API-Collections-Setup-<version>.exe` — an installer (NSIS). It installs to a
  folder the user chooses, adds Start Menu and desktop shortcuts, and registers
  an uninstaller in "Apps & features".
- `API-Collections-Portable-<version>.exe` — a single file that runs without
  installing.

## One-time setup

```powershell
npm install
npm run make-icon      # renders assets/logo.svg -> build/icon.ico + build/icon.png
npm run make-cert      # creates a self-signed code-signing certificate
```

## Build

```powershell
npm run dist:signed    # signed with the self-signed certificate
# or
npm run dist           # unsigned (or signed, if you set CSC_LINK yourself)
```

## Signing

The build is signed so Windows (and the user) can verify the installer has not
been modified since it left your machine, and so the publisher name shows as
"Delickate" instead of blank.

`npm run make-cert` creates a **self-signed** certificate under `build/certs/`
(git-ignored). This is right for internal and test use. It does **not** remove
the SmartScreen "Windows protected your PC / unknown publisher" prompt on other
people's machines, because no trusted certificate authority vouches for it.

### Using a real certificate (for public distribution)

Buy an **OV** or **EV** code-signing certificate from a CA (DigiCert, Sectigo,
SSL.com, …). EV certificates clear SmartScreen immediately; OV certificates
build reputation over time. Then build without the self-signed cert:

```powershell
$env:CSC_LINK = "C:\path\to\your-cert.pfx"      # or a base64 string of the .pfx
$env:CSC_KEY_PASSWORD = "your-cert-password"
npm run dist
```

For an EV certificate on a hardware token, follow the CA's signing instructions;
electron-builder also supports cloud signing (Azure Trusted Signing, etc.) via
its `win.signtoolOptions` / `azureSignOptions` config.

## Hardening applied to the build

These make the packaged app tamper-evident and close the usual doors, but no
desktop app can be made uncrackable — the code runs on the user's machine.
Keep anything that must stay secret on the server (this app already does: the
auth token lives in the main process and the UI has no Node access and a
network-blocking Content-Security-Policy).

- **Code signing** — the exe and installer carry a signature; any edit breaks it.
- **ASAR archive + integrity fuse** — the app code is packed into an archive
  whose hash Electron checks at launch (`EnableEmbeddedAsarIntegrityValidation`,
  `OnlyLoadAppFromAsar`). Editing the bundled JavaScript makes the app refuse to
  start.
- **Electron fuses** — in the packaged build, `ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS`, and the Node inspector/CLI debugging flags are disabled, so the
  binary cannot be re-pointed to run arbitrary code. Cookie encryption is on.

## Notes

- Output goes to `dist/`. Both `dist/` and `build/certs/` are git-ignored.
- The installer and portable exe are 64-bit. Add `ia32`/`arm64` targets in
  `package.json` → `build.win.target` if you need them.
- First build downloads electron-builder's helper binaries; later builds are
  faster.
