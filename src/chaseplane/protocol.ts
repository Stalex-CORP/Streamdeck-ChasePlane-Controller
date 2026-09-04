/**
 * Types describing the ChasePlane (MSFS 2024) Bridge WebSocket API.
 *
 * The protocol was derived from the official "ChasePlane Remote" web UI shipped inside
 * `CP MSFS Bridge.exe` and confirmed against live captures (see docs/chaseplane-bridge-api.md).
 */

/** Camera mode as reported by the bridge (`views[].mode`, `cam_mode_set.mode`). */
export const CameraMode = {
	/** Cockpit / cabin views. */
	Internal: 0,
	/** Views attached to the outside of the aircraft. */
	External: 1,
	/** Free / world views (drone, tower, runway, ...). */
	World: 2,
} as const;

/** Camera mode value: 0 internal, 1 external, 2 world. */
export type CameraMode = (typeof CameraMode)[keyof typeof CameraMode];

/** All camera modes, in the order ChasePlane displays them. */
export const CAMERA_MODES: readonly CameraMode[] = [CameraMode.Internal, CameraMode.External, CameraMode.World];

/** A camera view (preset) returned by `get_views`. Only the fields the plugin relies on are typed. */
export type CameraView = {
	/** Unique identifier of the view; used by `set_view_by_guid`. */
	guid: string;
	/** Name as entered by the user (not unique). */
	name: string;
	/** Camera mode the view belongs to. */
	mode: CameraMode;
	/** Position within its mode. */
	index?: number;
	/** `USER_DEFINED`, or a built-in world type such as `WORLD_TOWER`. */
	view_type?: string;
	/** Whether the view can be saved (false for built-in world views). */
	can_save?: boolean;
	/** Whether the view is skipped when cycling cameras. */
	skip_cycle?: boolean;
	/** Airport the world view is bound to, if any. */
	icao?: string;
	/** Name suffix flag: left side. */
	has_left_suffix?: boolean;
	/** Name suffix flag: right side. */
	has_right_suffix?: boolean;
	/** Name suffix flag: forward. */
	has_fwd_suffix?: boolean;
	/** Name suffix flag: middle. */
	has_mid_suffix?: boolean;
	/** Name suffix flag: aft. */
	has_aft_suffix?: boolean;
};

/** Payload of the `cam_mode_set` push event. */
export type CurrentCamera = {
	/** Active camera mode. */
	mode?: CameraMode;
	/** GUID of the active view. */
	preset_guid?: string | null;
	/** Name of the previewed view, if any. */
	preview_name?: string | null;
	/** Look-at target, if any. */
	look_at?: string | null;
	/** Whether cinematic mode is on. */
	cinematic_enabled?: boolean;
	/** Active control profile. */
	control_profile?: number;
	/** Whether the aircraft views are loaded. */
	views_loaded?: boolean;
	/** Whether ChasePlane is enabled. */
	master_enabled?: boolean;
};

/** Payload of the `initialized` event. */
export type SystemInfo = {
	/** ChasePlane version, e.g. `2026.35.4.22`. */
	chaseplane_version?: string;
	/** Simulator, e.g. `MSFS2024`. */
	simulator_version?: string;
	/** Simulator distribution, e.g. `Store`. */
	distribution?: string;
};

/** Reply of the `get_views` command (after unwrapping the reply envelope). */
export type GetViewsReply = {
	/** Loaded aircraft. */
	metadata?: {
		/** Aircraft folder name. */
		aircraft_folder?: string;
		/** Readable aircraft name. */
		aircraft_readable?: string;
	};
	/** Views of the loaded aircraft, plus global world views. */
	views?: CameraView[];
};

/** Any JSON message exchanged with the bridge. */
export type BridgeMessage = {
	/** Message type, e.g. `api_request`, `api_reply`, `cam_mode_set`. */
	message: string;
	/** Correlation identifier of requests and replies. */
	request_id?: string;
	/** Command name (requests only). */
	command?: string;
	/** HTTP-like status (replies only). */
	status?: number;
	/** Error description (failed replies only). */
	error?: string;
	/** Message payload. */
	payload?: unknown;
};

/**
 * Display name as ChasePlane shows it. Names are not unique ("Wing" x4): the bridge disambiguates
 * them with side / position suffix flags, and with an ICAO for airport-bound world views.
 * @param view The camera view.
 * @returns e.g. "Wing (R Fwd)", "Tower LFPG".
 */
export function getViewDisplayName(view: CameraView): string {
	const suffixes: string[] = [];
	if (view.has_left_suffix) suffixes.push("L");
	if (view.has_right_suffix) suffixes.push("R");
	if (view.has_fwd_suffix) suffixes.push("Fwd");
	if (view.has_mid_suffix) suffixes.push("Mid");
	if (view.has_aft_suffix) suffixes.push("Aft");

	let name = view.name?.trim() || "(unnamed)";
	if (suffixes.length > 0) name += ` (${suffixes.join(" ")})`;
	if (view.icao) name += ` ${view.icao}`;
	return name;
}
