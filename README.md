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
  imgs/plugin/                        Marketplace icon (256/512) and category icon (28/56, white)
  imgs/actions/camera/            action icon (20/40, white), default state images (72/144)
  imgs/actions/camera/keys/       key images per mode/state, generated at build (git-ignored)
  bin/plugin.js                       bundle, generated at build (git-ignored)
src/
  plugin.ts                           entry point: registers the action, connects, starts the client
  actions/camera.ts               "Set Camera" action (states, images, title, property inspector)
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

- [ ] `Author`, `URL` and `SupportURL` in `manifest.json` point to your Marketplace organization / real pages.
- [ ] Plugin and category name: "ChasePlane" is a Parallel 42 trademark — confirm naming with them or use a
      neutral name (UUIDs never change after publishing, names can).
- [ ] `npm run validate` passes with no warnings, `npm run pack` produces the bundle.
- [ ] Gallery images and description prepared for the Maker Console.
