# streamdeck-cp — context for Claude Code

Stream Deck plugin **"ChasePlane Cameras"** (`com.stalexcorp.chaseplane`): switches ChasePlane (MSFS 2024)
camera views from a Stream Deck. One key = one view; keys are grouped Internal / External / World in the
property inspector; the active view's key is highlighted. Goal: fully compliant with Elgato's SDK guides
and Marketplace guidelines so it can be published later. Author: Steve (Stalex). Language: talk to the
user in French, keep code/comments/docs in English.

## Status (2026-09-04)

- v0.2.0: complete rewrite following the official `streamdeck create` template + guides. Works end to end
  (verified against a mocked Stream Deck + mocked bridge, and live against ChasePlane 2026.35.4.22).
- `npm run lint` = 0 warnings, `npm run validate` passes (only warning: placeholder `URL` in manifest → 404).
- Open items (see README "Publishing checklist"): real `Author` / `URL` / `SupportURL`; decide on the plugin
  name ("ChasePlane" is a Parallel 42 trademark; UUIDs can never change once published, names can).
- The user is now iterating himself on visuals / behaviour.

## Layout

```
com.stalexcorp.chaseplane.sdPlugin/   the packaged plugin — manifest.json (SDK 3, Node 24, SD 7.1+),
                                      en.json / fr.json (i18n), ui/set-camera.html (sdpi-components v4,
                                      vendored in ui/sdpi-components.js), imgs/ (manifest icons)
  bin/, logs/, imgs/actions/set-camera/keys/   generated / runtime — git-ignored, never edit by hand
src/plugin.ts                         entry: register actions BEFORE streamDeck.connect(); exits on SIGTERM
src/actions/set-camera.ts             the only action (two manifest states: 0 Inactive, 1 Active)
src/chaseplane/client.ts              bridge client: reconnect loop, request/reply, push events
src/chaseplane/protocol.ts            protocol types + getViewDisplayName()
src/images/{internal,external,world}.png   user-provided white 64x64 icons (source of the key images)
scripts/key-images.mjs                builds keys/*.svg from src/images at every rollup build
scripts/probe.mjs                     `npm run probe [-- <guid>|--watch]` — raw bridge API probe
docs/chaseplane-bridge-api.md         reverse-engineered API reference, confirmed with live captures
```

## Commands

- `npm run build` / `npm run watch` (rebuild + `streamdeck restart com.stalexcorp.chaseplane`).
- `npm run lint` (`@elgato/eslint-config`, `--max-warnings 0`), `npm run format` (`@elgato/prettier-config`:
  tabs in TS/JS, 4 spaces in JSON, 120 cols). Run both before finishing any change.
- `npm run validate` (`streamdeck validate`), `npm run pack` (→ `dist/*.streamDeckPlugin`).
- Logs: `com.stalexcorp.chaseplane.sdPlugin/logs/com.stalexcorp.chaseplane.0.log` (0 = newest, one file per
  plugin start — a new file appearing is the proof a restart really happened).
- Property inspector debugging: http://localhost:23654/ (PI must be open in the Stream Deck app).

## Elgato rules this code follows (keep them)

- Settings: read from event payloads (`ev.payload.settings`), never rely on `getSettings()`; the PI stores
  only `guid`, the action caches `name`/`mode` in `onDidReceiveSettings` (only when they differ → no loop).
- Visual state: manifest states + `setState`, `DisableAutomaticStates: true`; images set by path
  (`setImage("imgs/.../keys/<mode>-<state>.svg", { state })`); a per-key cache sends only what changed
  (guideline: ≤ 10 key updates/s). Title via `setTitle`; a user-defined title always wins (SDK precedence),
  so there is deliberately no "auto title" setting.
- Feedback: `showAlert()` + log on failure; no `showOk()` (the state change is the visual feedback).
- PI: sdpi-components data source — PI sends `{event:"getCameras", isRefresh?}`, plugin answers
  `streamDeck.ui.sendToPropertyInspector({event:"getCameras", items:[{label, children:[{label,value}]}]})`
  (`event` must equal the `datasource` attribute; groups render as `<optgroup>`). Auto-save, no Save button,
  no donation/copyright links. Extra `{event:"status", connected, aircraft, isActive}` for the status line.
- i18n: manifest strings + `Localization` keys in `en.json`/`fr.json` (`streamDeck.i18n.translate`);
  PI strings via `SDPIComponents.i18n.locales` + `__MSG_key__` / `<sdpi-i18n key>`.
- Images: Marketplace icon 256/512 PNG; category + action icons white monochrome on transparent (28/56,
  20/40); state images 72/144; always ship `@2x`. Never read/modify files under the plugin at runtime.
- Logging: `streamDeck.logger` scopes only, no `console`. Default level (debug in dev, info in prod).

## Hard-won gotchas

1. **`streamdeck restart` silently does nothing unless developer mode is on** (`streamdeck dev`, sets
   `HKCU\Software\Elgato Systems GmbH\StreamDeck\developer_mode=1`; then restart the app once). The CLI
   just opens `streamdeck://plugins/restart/<uuid>` and prints "Restarted" regardless.
2. **Stream Deck stops a plugin by closing its WebSocket and waiting for the process to exit.** The SDK
   never calls `process.exit`. Every timer in the client is `.unref()`ed and the bridge socket is
   `_socket.unref()`ed on open; `plugin.ts` also exits on SIGTERM/SIGINT/SIGHUP. Any new long-lived handle
   (timers, sockets, servers) MUST be unref'ed or hot reload breaks again (zombie process, old code stays).
3. **Bridge ports:** HTTP `localhost:8651` (`/health`, remote UI, `/control_assignments/`, `/tiles/…`) is
   up as soon as the bridge runs; the WebSocket API `ws://localhost:8652` only listens once a flight is
   loaded. Protocol: `api_connect` → `api_version` + `initialized`; `api_request{request_id,command,payload}`
   → `api_reply{request_id,status,payload}` whose payload is a nested `{message,payload}` envelope (unwrap up
   to 4 levels, like the official client); ignore raw `PING`/`PING_BRIDGE`. Active camera: `cam_mode_set.preset_guid`.
   Views are not unique by name — use `getViewDisplayName()` (suffix flags + ICAO).
4. **Dependency pins are deliberate — do not bump majors:** TypeScript 7 breaks `@rollup/plugin-typescript`;
   ESLint 10 breaks `@elgato/eslint-config` (peer `eslint ^9.26`); `@types/node` must match the Node 24
   runtime shipped by Stream Deck (`~24.x`, not 26).
5. Files synced into this folder by other tools may be read-only on Windows; build scripts already handle
   EPERM (compare-then-overwrite). If `npm run build` still hits EPERM, `attrib -R /S *` at the project root.
6. Some tooling on this machine: Stream Deck 7.5.1, Node 24.13.1 runtime, Edge (not Chrome), MSFS 2024 with
   ChasePlane in `G:\MFS\Community\p42-util-chaseplane`.

## Testing without hardware

`.test-plugin.mjs`-style harness (not committed): spawn `bin/plugin.js` with
`-port <p> -pluginUUID com.stalexcorp.chaseplane -registerEvent registerPlugin -info <json with devices[]>`,
run a `ws` server as fake Stream Deck (send `willAppear`, `keyDown`, `didReceiveSettings`, `sendToPlugin`)
and another on 8652 as fake bridge replaying the message shapes from docs/chaseplane-bridge-api.md.
The `-info` JSON must list the device used by `willAppear` or the SDK throws "device not found".
