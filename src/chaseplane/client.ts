import { EventEmitter } from "node:events";
import WebSocket from "ws";

import {
	type BridgeMessage,
	CAMERA_MODES,
	type CameraMode,
	type CameraView,
	type CurrentCamera,
	type GetViewsReply,
	type SystemInfo,
} from "./protocol";

/** Default endpoint of the ChasePlane bridge WebSocket API. */
export const DEFAULT_BRIDGE_URL = "ws://localhost:8652";

/** Delay between reconnection attempts while the simulator / bridge is not running. */
const RECONNECT_DELAY_MS = 3_000;

/** Requests without a reply after this delay are rejected. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Minimal logger contract, satisfied by `streamDeck.logger`. */
export type Logger = {
	/** Logs a debug message. */
	debug(message: string): unknown;
	/** Logs an informational message. */
	info(message: string): unknown;
	/** Logs a warning. */
	warn(message: string): unknown;
	/** Logs an error. */
	error(message: string): unknown;
};

/** Events emitted by {@link ChasePlaneClient}. */
export type ChasePlaneClientEvents = {
	/** The bridge accepted the handshake; requests can be sent. */
	ready: [info: SystemInfo];
	/** The connection to the bridge was lost. */
	disconnected: [];
	/** The list of camera views changed (aircraft loaded, view created / edited / deleted). */
	viewsChanged: [views: CameraView[]];
	/** The active camera changed. */
	cameraChanged: [camera: CurrentCamera];
};

/** Options of {@link ChasePlaneClient}. */
export type ChasePlaneClientOptions = {
	/** Logger used for diagnostics. */
	logger: Logger;
	/** Bridge WebSocket endpoint; defaults to {@link DEFAULT_BRIDGE_URL}. */
	url?: string;
	/** Client name announced to the bridge. */
	clientName?: string;
};

/** Views grouped by camera mode. */
export type ViewsByMode = {
	/** Camera mode. */
	mode: CameraMode;
	/** Views of that mode, in ChasePlane order. */
	views: CameraView[];
};

/** Subset of the `ws` socket internals used to detach it from the event loop. */
type UnrefableSocket = {
	/** Underlying TCP socket. */
	_socket?: {
		/** Lets the process exit even while the socket is open. */
		unref?: () => void;
	};
};

/** A request awaiting its reply. */
type PendingRequest = {
	/** Command name, for diagnostics. */
	command: string;
	/** Resolves the request with the reply payload. */
	resolve: (value: unknown) => void;
	/** Rejects the request. */
	reject: (reason: Error) => void;
	/** Time the request was sent, for timeouts. */
	timestamp: number;
};

/**
 * Client for the ChasePlane bridge API (`CP MSFS Bridge.exe`).
 *
 * Transport is JSON over WebSocket. After `api_connect`, the bridge answers `api_version` then
 * `initialized`; requests use `api_request` / `api_reply` correlated by `request_id`, and state
 * changes are pushed (`cam_mode_set`, `view_created`, ...). Raw `PING` frames are ignored.
 *
 * The client reconnects forever while started, and never keeps the Node.js event loop alive on
 * its own: Stream Deck stops a plugin by closing its connection and waiting for the process to exit.
 */
export class ChasePlaneClient extends EventEmitter<ChasePlaneClientEvents> {
	/** Readable name of the loaded aircraft. */
	public aircraft = "";
	/** Last known active camera. */
	public currentCamera: CurrentCamera | null = null;
	/** Whether the handshake completed and the bridge accepts requests. */
	public isReady = false;
	/** Information reported by the bridge on `initialized`. */
	public systemInfo: SystemInfo = {};
	/** Camera views of the loaded aircraft. */
	public views: CameraView[] = [];

	/** Client name announced to the bridge. */
	private readonly clientName: string;
	/** Logger used for diagnostics. */
	private readonly logger: Logger;
	/** Requests awaiting a reply, by request identifier. */
	private readonly pending = new Map<string, PendingRequest>();
	/** Pending reconnection attempt. */
	private reconnectTimer: NodeJS.Timeout | null = null;
	/** Pending (debounced) views refresh. */
	private refreshTimer: NodeJS.Timeout | null = null;
	/** Whether {@link ChasePlaneClient.start} was called. */
	private started = false;
	/** Periodic check rejecting timed-out requests. */
	private timeoutTimer: NodeJS.Timeout | null = null;
	/** Bridge WebSocket endpoint. */
	private readonly url: string;
	/** Current socket, if any. */
	private ws: WebSocket | null = null;

	/**
	 * Initializes a new instance of the {@link ChasePlaneClient} class.
	 * @param options Connection options.
	 */
	constructor(options: ChasePlaneClientOptions) {
		super();
		this.logger = options.logger;
		this.url = options.url ?? DEFAULT_BRIDGE_URL;
		this.clientName = options.clientName ?? "Stream Deck";
	}

	/**
	 * GUID of the active camera preset, if any.
	 * @returns The GUID, or `null`.
	 */
	public get activeGuid(): string | null {
		return this.currentCamera?.preset_guid ?? null;
	}

	/**
	 * Finds a view by GUID.
	 * @param guid View GUID.
	 * @returns The view, or `undefined`.
	 */
	public findView(guid: string): CameraView | undefined {
		return this.views.find((v) => v.guid === guid);
	}

	/**
	 * Gets the camera views of a mode.
	 * @param mode Camera mode.
	 * @returns Views of that mode, in ChasePlane order.
	 */
	public getViews(mode: CameraMode): CameraView[] {
		return this.views.filter((v) => v.mode === mode);
	}

	/**
	 * Gets the views grouped by mode, in the order ChasePlane displays them.
	 * @returns One entry per mode.
	 */
	public getViewsByMode(): ViewsByMode[] {
		return CAMERA_MODES.map((mode) => ({ mode, views: this.getViews(mode) }));
	}

	/**
	 * Re-reads the camera views from the bridge.
	 * @returns The views.
	 */
	public async refreshViews(): Promise<CameraView[]> {
		try {
			const reply = await this.request<GetViewsReply>("get_views");
			if (reply && Array.isArray(reply.views)) {
				this.views = reply.views;
				this.aircraft = reply.metadata?.aircraft_readable ?? reply.metadata?.aircraft_folder ?? "";
				this.emit("viewsChanged", this.views);
			}
		} catch (err) {
			this.logger.warn(`get_views failed: ${(err as Error).message}`);
		}

		return this.views;
	}

	/**
	 * Sends a request to the bridge.
	 * @param command Command name.
	 * @param payload Command payload.
	 * @returns The reply payload.
	 */
	public request<T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (!this.isReady) {
				reject(new Error("Not connected to ChasePlane"));
				return;
			}

			const requestId = `${command}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
			this.pending.set(requestId, {
				command,
				resolve: resolve as (value: unknown) => void,
				reject,
				timestamp: Date.now(),
			});
			this.send({ message: "api_request", request_id: requestId, command, payload });
		});
	}

	/**
	 * Switches to a camera view.
	 * @param guid GUID of the view.
	 * @returns Promise resolved when the bridge acknowledged the request.
	 */
	public setViewByGuid(guid: string): Promise<unknown> {
		return this.request("set_view_by_guid", { guid });
	}

	/**
	 * Starts the client; it reconnects automatically until {@link ChasePlaneClient.stop} is called.
	 */
	public start(): void {
		this.started = true;
		this.connect();
	}

	/**
	 * Stops the client and closes the connection.
	 */
	public stop(): void {
		this.started = false;
		this.clearTimers();
		this.ws?.close();
		this.ws = null;
	}

	/**
	 * Cancels every timer.
	 */
	private clearTimers(): void {
		if (this.timeoutTimer) clearInterval(this.timeoutTimer);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.timeoutTimer = this.reconnectTimer = this.refreshTimer = null;
	}

	/**
	 * Opens the socket and performs the handshake.
	 */
	private connect(): void {
		if (!this.started || this.ws) {
			return;
		}

		this.logger.debug(`Connecting to ${this.url}`);
		const ws = new WebSocket(this.url, { handshakeTimeout: 4_000 });
		this.ws = ws;

		ws.on("open", () => {
			// The socket must not keep the process alive once Stream Deck disconnects.
			(ws as unknown as UnrefableSocket)._socket?.unref?.();
			this.send({ message: "api_connect", payload: { client_name: this.clientName } });
			this.startTimeoutCheck();
		});

		ws.on("message", (data) => this.onMessage(data.toString()));

		ws.on("error", (err) => {
			// ECONNREFUSED is expected whenever the simulator is not running.
			this.logger.debug(`Socket error: ${err.message}`);
		});

		ws.on("close", () => {
			const wasReady = this.isReady;
			this.ws = null;
			this.isReady = false;
			this.clearTimers();

			for (const req of this.pending.values()) {
				req.reject(new Error("Disconnected"));
			}
			this.pending.clear();

			if (wasReady) {
				this.logger.info("Disconnected from ChasePlane bridge");
				this.emit("disconnected");
			}

			this.scheduleReconnect();
		});
	}

	/**
	 * Handles a frame received from the bridge.
	 * @param data Raw frame.
	 */
	private onMessage(data: string): void {
		if (data === "PING" || data === "PING_BRIDGE") {
			return;
		}

		let msg: BridgeMessage;
		try {
			msg = JSON.parse(data) as BridgeMessage;
		} catch {
			return;
		}

		switch (msg.message) {
			case "initialized":
				this.isReady = true;
				this.systemInfo = (msg.payload as SystemInfo) ?? {};
				this.logger.info(`Connected to ChasePlane bridge (${this.systemInfo.chaseplane_version ?? "unknown version"})`);
				this.emit("ready", this.systemInfo);
				void this.refreshViews();
				break;

			case "cam_mode_set":
				this.currentCamera = (msg.payload as CurrentCamera) ?? null;
				this.emit("cameraChanged", this.currentCamera ?? {});
				break;

			case "view_created":
			case "view_modified":
			case "view_deleted":
				this.scheduleRefresh();
				break;

			case "api_reply":
				this.onReply(msg);
				break;

			default:
				break;
		}
	}

	/**
	 * Settles the pending request matching a reply.
	 * @param msg The `api_reply` message.
	 */
	private onReply(msg: BridgeMessage): void {
		const req = msg.request_id ? this.pending.get(msg.request_id) : undefined;
		if (!req || !msg.request_id) {
			return;
		}

		this.pending.delete(msg.request_id);
		if (msg.status !== 200) {
			req.reject(new Error(`${msg.error ?? "Bridge error"} (${msg.status})`));
			return;
		}

		// Replies wrap their payload in nested { message, payload } envelopes; unwrap like the official client.
		let payload = msg.payload;
		for (let i = 0; i < 4; i++) {
			if (!payload || typeof payload !== "object" || !("payload" in payload)) break;
			if (!("message" in payload) && !("status" in payload)) break;
			payload = (payload as BridgeMessage).payload;
		}

		req.resolve(payload);
	}

	/**
	 * Schedules a reconnection attempt.
	 */
	private scheduleReconnect(): void {
		if (!this.started || this.reconnectTimer) {
			return;
		}

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, RECONNECT_DELAY_MS).unref();
	}

	/**
	 * Schedules a (debounced) views refresh.
	 */
	private scheduleRefresh(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshViews();
		}, 250).unref();
	}

	/**
	 * Sends a message when the socket is open.
	 * @param message The message.
	 */
	private send(message: BridgeMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
		}
	}

	/**
	 * Starts the periodic request-timeout check.
	 */
	private startTimeoutCheck(): void {
		this.timeoutTimer = setInterval(() => {
			const now = Date.now();
			for (const [id, req] of this.pending) {
				if (now - req.timestamp > REQUEST_TIMEOUT_MS) {
					req.reject(new Error(`Request timeout (${req.command})`));
					this.pending.delete(id);
				}
			}
		}, 5_000).unref();
	}
}
