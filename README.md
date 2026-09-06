# ChasePlane — Stream Deck plugin

Switch [ChasePlane](https://parallel42.com/products/chaseplane) (MSFS 2024) camera views from a Stream Deck.
One key = one view; the key is highlighted while that view is active. Views are listed per aircraft and
grouped as in ChasePlane (Internal / External / World).

Built with the official [Stream Deck SDK](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started)
(`@elgato/streamdeck` v2, SDK version 3, Node.js 24, Stream Deck 7.1+), following Elgato's
[plugin guidelines](https://docs.elgato.com/guidelines/stream-deck/plugins).

## How it works

`CP MSFS Bridge.exe` (installed with ChasePlane) exposes a local WebSocket API on `ws://localhost:8652`,
the same one used by the official "ChasePlane Remote" web UI. The plugin connects to it, lists the views
(`get_views`), switches cameras (`set_view_by_guid`) and follows the active camera (`cam_mode_set`).
The protocol is documented in [docs/chaseplane-bridge-api.md](docs/chaseplane-bridge-api.md).

## Project layout

```
fr.stalexcorp.msfschaseplane.sdPlugin/   the plugin (what gets packaged)
  manifest.json                       SDK 3 manifest
  en.json, fr.json                    localization (plugin / action names, group labels)
  ui/camera.html                  property inspector (sdpi-components v4, vendored)
  imgs/plugin/                        Marketplace icon (256/512 PNG) and category icon (SVG, white)
  imgs/actions/<action>/          action icon (SVG, white)
  imgs/actions/camera/keys/       key images per mode/state + manifest default states, generated at build (git-ignored)
  bin/plugin.js                       bundle, generated at build (git-ignored)
src/
  plugin.ts                           entry point: registers the action, connects, starts the client
  actions/camera.ts               "Camera" action (states, images, title, property inspector)
  actions/toggle.ts               "Cinematic" / "Flashlight" on-off actions
  chaseplane/client.ts                bridge client (handshake, request/reply, events, reconnection)
  chaseplane/protocol.ts              protocol types and helpers
  images/{internal,external,world}.png white 64x64 icons used to build the key images
scripts/key-images.mjs                key image generator (run by rollup, or `node scripts/key-images.mjs`)
scripts/probe.mjs                     CLI probe for the bridge API (`npm run probe`)
```

## Development

```powershell
npm install
npm run build              # rollup → bin/plugin.js (+ key images)
streamdeck dev             # once: enables developer mode (needed for link / restart)
streamdeck link fr.stalexcorp.msfschaseplane.sdPlugin   # once
npm run watch              # rebuild + restart the plugin on every change
```

- `npm run lint` — ESLint with `@elgato/eslint-config` (zero warnings policy).
- `npm run format` — Prettier with `@elgato/prettier-config`.
- `npm run validate` — `streamdeck validate` (manifest, images, layout rules).
- `npm run pack` — `streamdeck pack` → `dist/fr.stalexcorp.msfschaseplane.streamDeckPlugin`.
- Logs: `fr.stalexcorp.msfschaseplane.sdPlugin/logs/`. Property inspector debugging: http://localhost:23654/.

## Publishing checklist (Marketplace)

Plugin side (verified against Elgato's plugin guidelines, 2026-09-06):

- [x] UUIDs in reverse-DNS with author + plugin name; action UUIDs prefixed with the plugin UUID.
- [x] Category = plugin name; action names ≤ 30 chars with tooltips; 2–30 configurable actions.
- [x] Marketplace icon 256/512 PNG; category and action icons white monochrome SVG on transparent.
- [x] State images 72/144 (SVG); `showAlert()` on failure; no `showOk()`; ≤ 10 key updates/s.
- [x] Property inspectors: auto-save, no Save button, no donation / copyright links, components hidden until ready.
- [x] `Nodejs.Debug` removed; bundle minified without source maps; `logs/` excluded by `.sdignore`.
- [x] `npm run validate` passes (only warning: `URL` 404 until the repository exists); `npm run pack` → ~105 KB bundle.
- [ ] `Author` must be the Marketplace organization name; `URL` / `SupportURL` must resolve (create the GitHub repo or change them).
- [ ] Plugin name: "ChasePlane" is a Parallel 42 trademark — get their agreement or use a neutral name (UUIDs never change, names can).
- [ ] Optional per guidelines: a support link inside the property inspectors ("provide setup help with support page links").

Maker Console side:

- [ ] App icon 288 × 288 PNG (product name / logo as focus).
- [ ] 1 thumbnail + 3 to 10 gallery images, 1920 × 960 PNG (or MP4 1920 × 1080); real Stream Deck depictions.
- [ ] Description in English, 250–1500 characters, 2–4 sentences, mentioning MSFS 2024 + ChasePlane as requirements.
- [ ] Review takes 4–10 working days; a demo video may be requested since the plugin depends on third-party software.
