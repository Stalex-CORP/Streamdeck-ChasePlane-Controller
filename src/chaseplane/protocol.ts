/**
 * Types of the ChasePlane (MSFS 2024) bridge WebSocket API. See docs/chaseplane-bridge-api.md.
 */

/** Camera mode (`views[].mode`, `cam_mode_set.mode`). */
export const CameraMode = {
	/** Cockpit / cabin. */
	Internal: 0,
	/** Attached to the aircraft. */
	External: 1,
	/** Drone, tower, runway, ... */
	World: 2,
} as const;

/** Camera mode value. */
export type CameraMode = (typeof CameraMode)[keyof typeof CameraMode];

/** Camera modes in ChasePlane display order. */
export const CAMERA_MODES: readonly CameraMode[] = [CameraMode.Internal, CameraMode.External, CameraMode.World];

/** A camera view returned by `get_views` (only the fields used by the plugin). */
export type CameraView = {
	/** Unique identifier, used by `set_view_by_guid`. */
	guid: string;
	/** User-facing name (not unique). */
	name: string;
	/** Camera mode. */
	mode: CameraMode;
	/** Position within its mode. */
	index?: number;
	/** `USER_DEFINED`, or a built-in world type such as `WORLD_TOWER`. */
	view_type?: string;
	/** False for built-in world views. */
	can_save?: boolean;
	/** Skipped when cycling cameras. */
	skip_cycle?: boolean;
	/** Airport of an airport-bound world view. */
	icao?: string;
	/** Name suffix: left. */
	has_left_suffix?: boolean;
	/** Name suffix: right. */
	has_right_suffix?: boolean;
	/** Name suffix: forward. */
	has_fwd_suffix?: boolean;
	/** Name suffix: middle. */
	has_mid_suffix?: boolean;
	/** Name suffix: aft. */
	has_aft_suffix?: boolean;
};

/** Payload of the `cam_mode_set` push event. */
export type CurrentCamera = {
	/** Active camera mode. */
	mode?: CameraMode;
	/** GUID of the active view. */
	preset_guid?: string | null;
	/** Previewed view name. */
	preview_name?: string | null;
	/** Look-at target. */
	look_at?: string | null;
	/** Cinematic mode on. */
	cinematic_enabled?: boolean;
	/** Active control profile. */
	control_profile?: number;
	/** Aircraft views loaded. */
	views_loaded?: boolean;
	/** ChasePlane enabled. */
	master_enabled?: boolean;
};

/** Payload of the `sim_state` push event (frequent; only the fields used by the plugin). */
export type SimState = {
	/** Reported true only while the flashlight is on (not a precondition). */
	flashlight_available?: boolean;
	/** Flashlight on. */
	flashlight_enabled?: boolean;
};

/** Payload of the `initialized` event. */
export type SystemInfo = {
	/** ChasePlane version. */
	chaseplane_version?: string;
	/** Simulator, e.g. `MSFS2024`. */
	simulator_version?: string;
	/** Distribution, e.g. `Store`. */
	distribution?: string;
};

/** Reply of `get_views` (after unwrapping the envelope). */
export type GetViewsReply = {
	/** Loaded aircraft. */
	metadata?: {
		/** Aircraft folder name. */
		aircraft_folder?: string;
		/** Readable aircraft name. */
		aircraft_readable?: string;
	};
	/** Views of the aircraft plus global world views. */
	views?: CameraView[];
};

/** Any JSON message exchanged with the bridge. */
export type BridgeMessage = {
	/** Message type. */
	message: string;
	/** Correlation identifier of requests and replies. */
	request_id?: string;
	/** Command name (requests). */
	command?: string;
	/** HTTP-like status (replies). */
	status?: number;
	/** Error description (failed replies). */
	error?: string;
	/** Payload. */
	payload?: unknown;
};

/**
 * Display name as ChasePlane shows it: names are not unique ("Wing" x4), so the side / position
 * suffix flags and the ICAO of airport-bound world views are appended.
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
