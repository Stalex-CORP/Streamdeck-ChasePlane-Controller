# ChasePlane MSFS 2024 — API WebSocket du Bridge (reverse de la remote UI)

Source : client JS `remote-ui.js` embarqué dans `CP MSFS Bridge.exe` (ressource `ChasePlane_MSFS_Bridge.WebServer.wwwroot.remote_assets.remote-ui.js`), version package 26.35.4. Tout ce qui suit est ce que la « ChasePlane Remote » officielle envoie ; un plugin Stream Deck fait exactement la même chose.

## Transport

- URL : `ws://localhost:8652` (le HTTP sur 8651 ne sert que les fichiers de l'UI + `/health`).
- Texte JSON, un message par frame. Les frames brutes `PING` / `PING_BRIDGE` sont à ignorer.
- Enveloppe : `{ "message": "<type>", "payload": {...} }`, plus `request_id` pour le request/reply.

## Handshake

1. Dès `onopen`, envoyer :
   ```json
   { "message": "api_connect", "payload": { "client_name": "StreamDeck" } }
   ```
2. Le bridge répond `{"message":"api_version","payload":{"version":...}}` puis
   `{"message":"initialized","payload":{...systemInfo}}`. À partir de `initialized`, on peut envoyer des requêtes (le client officiel refuse avant : « Not connected »).

## Requêtes / réponses

Requête :
```json
{ "message": "api_request", "request_id": "get_views_1725380000000_ab12cd34e", "command": "get_views", "payload": {} }
```
Réponse :
```json
{ "message": "api_reply", "request_id": "...", "status": 200, "payload": {...} }
```
`status != 200` → erreur dans `error`. Le client officiel timeoute une requête après 30 s. Le `payload` de réponse peut être imbriqué (`payload.payload`…) : le client déroule jusqu'à 4 niveaux tant qu'il trouve `{message|status, payload}`.

### Commandes (`command` → `payload`)

Caméras / vues
- `get_views` → `{}` ; réponse `{ views: [...], metadata: { aircraft, aircraft_readable } }`. Chaque vue : `guid`, `name`, `mode` (0 = cockpit, 1 = external, 2 = world), `view_type` (pour les world : `WORLD_DRONE`, `WORLD_TOWER`, `WORLD_SPOTTING`, `WORLD_RUNWAY`, `WORLD_PARKING`, `WORLD_TRAFFIC`), `can_save`, …
- `set_view_by_guid` → `{ guid }` — **la commande clé pour un bouton Stream Deck = une vue**.
- `reorder_views` → `{ guids: [...] }`
- `set_camera_mode` → `{ mode: 0|1|2 }`
- `set_control_profile` → `{ mode }`
- `set_master_enabled` → `{ enabled: bool }` (désactive/active ChasePlane)
- `cam_cinematic_toggle`, `cam_cinematic_next`, `cam_flashlight_toggle`, `cam_preview_dismiss` → `{}`
- `cam_lookat_set` → `{ preset_guid, values }` ; `cam_lookat_unset` → `{}`

Monde / aéroports / trafic
- `request_airports`, `request_airport_details` `{ ident }`, `set_active_airport` `{ ident }`
- `cam_go_to_nearest` → `{ kind: "tower"|"runway"|"parking"|"spotting" }`
- `cam_go_to_airport_index` → `{ kind, index, end }`
- `cam_world_relocate` → `{ longitude, latitude, altitude, transition: true }`
- `cam_world_set_buffer` → `{ values }`
- `request_ai_traffic`, `start_ai_traffic_refresh`, `stop_ai_traffic_refresh`
- `ai_traffic_view` `{ id }`, `ai_traffic_track` `{ id }`, `cam_go_to_traffic` `{ simobject_id }`
- `target_center_traffic`, `user_aircraft_track` → `{}`
- `ai_traffic_auto_target_set` → `{ enabled }`
- `set_ai_traffic_filters` `{ filters }`, `set_ai_traffic_strip_layout` `{ layout | serialized_layout }`
- `set_user_setting` → `{ key, value }`

Côté panel in-game (autre client, même socket) : `get_all_assignments` → `{}`.

## Messages « fire and forget » (sans request_id)

- `cam_load_default` → `{}`
- `cam_slider_move` → `{ axis, value }` (axes vus dans l'UI : `pitch`, `roll`, `yaw`, `zoom`, `altitude`, + déplacement XYZ) ; `cam_slider_reset` → `{ axis }`
- `cam_set_axis` → `{ guid, axis, value }`
- `cam_set_position` → `{ version: 1, mode, name, profile_physics_type, profile_theme ("ONBOARD_PIC" | "OUTSIDE_CHASE" | "WORLD_DEFAULT"), can_transition, transition_time (ms), transition_easing: "DEFAULT", position }`

## Événements poussés par le bridge (message → payload)

`cam_mode_set` (caméra courante : `mode`, `preset_guid`, `look_at`, `cinematic_enabled`, `preview_name`…), `view_created` / `view_modified` / `view_deleted`, `camera_runtime_state` (`master_enabled`, `flashlight_enabled`…), `sim_state` (lat/lon/alt, `on_ground`, `units_of_measure`…), `airports`, `airport_upsert`, `airport_remove`, `airport_changed`, `ai_traffic`, `ai_traffic_auto_target_no_candidates`, `ai_traffic_auto_target_no_traffic`, `user_settings`.

Pour un Stream Deck : écouter `cam_mode_set` pour surligner la touche de la vue active (`preset_guid` == `guid` de la vue), et `view_*` pour rafraîchir la liste.

Confirmé le 06/09/2026 : `cam_cinematic_toggle` et `cam_flashlight_toggle` répondent `{ success: true }`. L'état cinématique revient dans `cam_mode_set.cinematic_enabled` ; l'état de la flashlight est dans `sim_state` (`flashlight_available`, `flashlight_enabled`), poussé en continu, pas dans `camera_runtime_state`.

Confirmé le 06/09/2026 : **réordonner les vues dans ChasePlane ne pousse aucun événement** (ni `view_modified`, ni autre). Un client qui dépend de l'ordre (vue par défaut = première vue interne) doit relancer `get_views` au moment de s'en servir.

## Squelette Node (SDK Elgato `@elgato/streamdeck`, côté plugin)

```js
import WebSocket from "ws";

class ChasePlane {
  constructor(url = "ws://localhost:8652") { this.url = url; this.ready = false; this.pending = new Map(); this.on = {}; }
  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on("open", () => this.ws.send(JSON.stringify({ message: "api_connect", payload: { client_name: "StreamDeck" } })));
    this.ws.on("message", (raw) => {
      const s = raw.toString(); if (s === "PING" || s === "PING_BRIDGE") return;
      let m; try { m = JSON.parse(s); } catch { return; }
      if (m.message === "initialized") { this.ready = true; this.on.ready?.(m.payload); }
      else if (m.message === "api_reply") { const p = this.pending.get(m.request_id); if (!p) return; this.pending.delete(m.request_id); m.status === 200 ? p.res(m.payload) : p.rej(new Error(`${m.error} (${m.status})`)); }
      else this.on[m.message]?.(m.payload);
    });
    this.ws.on("close", () => { this.ready = false; setTimeout(() => this.connect(), 2000); });
    this.ws.on("error", () => {});
  }
  request(command, payload = {}) {
    if (!this.ready) return Promise.reject(new Error("Not connected"));
    const id = `${command}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ message: "api_request", request_id: id, command, payload })); });
  }
  getViews()        { return this.request("get_views"); }
  setView(guid)     { return this.request("set_view_by_guid", { guid }); }
  cinematicToggle() { return this.request("cam_cinematic_toggle"); }
  setMaster(on)     { return this.request("set_master_enabled", { enabled: on }); }
}
```

Usage : au `ready`, `getViews()` → remplir la property inspector avec `views[].name` / `guid` ; `onKeyDown` → `setView(guid)` ; sur `cam_mode_set` → `setState`/`setImage` de la touche dont le guid correspond à `payload.preset_guid`.

## Confirmé en live (capture du 03/09/2026, CP 2026.35.4.22, PMDG 777-300ER)

- `initialized.payload` = `{ chaseplane_version, simulator_version: "MSFS2024", distribution }`
- `cam_mode_set.payload` = `{ mode, preset_guid, preview_name, look_at, cinematic_enabled, control_profile, views_loaded, master_enabled, head_tracking_enabled, look_at_position }`
- `get_views` → `api_reply.payload` = `{ message: "get_views", payload: { metadata: { version, aircraft_folder, aircraft_readable }, views: [...] } }` (enveloppe imbriquée, à déballer)
- Chaque vue : `guid`, `guid_community`, `name`, `mode`, `index`, `view_type` (`USER_DEFINED` ou `WORLD_DRONE|FLYBY|OVERVIEW|TOWER|RUNWAY|PARKING|SPOTTING|TRAFFIC` pour les vues world intégrées, `can_save:false`), `icao` (vues world liées à un aéroport), `profile_physics_type`, `profile_theme`, `position {x,y,z,pitch,yaw,roll,zoom}`, `shortcuts[]`, `skip_cycle`, `can_cinematics`, et les flags `has_left/right/fwd/mid/aft_suffix` qui distinguent les vues homonymes ("Wing" ×4).

## Reste à vérifier

- Format exact de `systemInfo` (`initialized`) et des champs de `views[]`.
- Si le bridge accepte plusieurs clients simultanés (remote UI + panel + plugin) — très probablement oui puisque le panel et la remote coexistent.
- Valeurs acceptées pour `set_control_profile.mode` et les noms d'axes de `cam_slider_move`.

Le plus simple : ouvrir `http://localhost:8651/` dans Chrome, DevTools → Network → WS → onglet Messages, et cliquer sur les vues pour voir les trames réelles.
