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

/** Default endpoint of the bridge WebSocket API. */
export const DEFAULT_BRIDGE_URL = "ws://localhost:8652";

const RECONNECT_DELAY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Minimal logger contract, satisfied by `streamDeck.logger`. */
export type Logger = {
	/** Debug. */
	debug(message: string): unknown;
	/** Info. */
	info(message: string): unknown;
	/** Warning. */
	warn(message: string): unknown;
	/** Error. */
	error(message: string): unknown;
};

/** Events emitted by {@link ChasePlaneClient}. */
export type ChasePlaneClientEvents = {
	/** Handshake done; requests can be sent. */
	ready: [info: SystemInfo];
	/** Connection lost. */
	disconnected: [];
	/** View list changed (aircraft loaded, view created / edited / deleted). */
	viewsChanged: [views: CameraView[]];
	/** Active camera changed. */
	cameraChanged: [camera: CurrentCamera];
};

/** Options of {@link ChasePlaneClient}. */
export type ChasePlaneClientOptions = {
	/** Logger. */
	logger: Logger;
	/** Bridge endpoint; defaults to {@link DEFAULT_BRIDGE_URL}. */
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

/** `ws` socket internals needed to detach it from the event loop. */
type UnrefableSocket = {
	/** Underlying TCP socket. */
	_socket?: {
		/** Lets the process exit while the socket is open. */
		unref?: () => void;
	};
};

/** A request awaiting its reply. */
type PendingRequest = {
	/** Command name. */
	command: string;
	/** Resolves with the reply payload. */
	resolve: (value: unknown) => void;
	/** Rejects the request. */
	reject: (reason: Error) => void;
	/** Time sent. */
	timestamp: number;
};

/**
 * Client for the ChasePlane bridge API (`CP MSFS Bridge.exe`): JSON over WebSocket, `api_connect`
 * handshake, `api_request` / `api_reply` correlated by `request_id`, push events for state changes.
 *
 * Reconnects forever while started. Never keeps the event loop alive on its own: Stream Deck stops a
 * plugin by closing its connection and waiting for the process to exit.
 */
export class ChasePlaneClient extends EventEmitter<ChasePlaneClientEvents> {
	/** Readable name of the loaded aircraft. */
	public aircraft = "";
	/** Last known active camera. */
	public currentCamera: CurrentCamera | null = null;
	/** Whether the bridge accepts requests. */
	public isReady = false;
	/** Reported on `initialized`. */
	public systemInfo: SystemInfo = {};
	/** Views of the loaded aircraft. */
	public views: CameraView[] = [];

	/** Client name announced to the bridge. */
	private readonly clientName: string;
	/** Logger. */
	private readonly logger: Logger;
	/** Requests awaiting a reply. */
	private readonly pending = new Map<string, PendingRequest>();
	/** Pending reconnection. */
	private reconnectTimer: NodeJS.Timeout | null = null;
	/** Pending (debounced) views refresh. */
	private refreshTimer: NodeJS.Timeout | null = null;
	/** Whether {@link ChasePlaneClient.start} was called. */
	private started = false;
	/** Periodic request-timeout check. */
	private timeoutTimer: NodeJS.Timeout | null = null;
	/** Bridge endpoint. */
	private readonly url: string;
	/** Current socket. */
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
	 * GUID of the active view.
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
	 * Gets the views of a mode.
	 * @param mode Camera mode.
	 * @returns Views of that mode, in ChasePlane order.
	 */
	public getViews(mode: CameraMode): CameraView[] {
		return this.views
			.filter((v) => v.mode === mode)
			.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
	}

	/**
	 * Gets the views grouped by mode.
	 * @returns One entry per mode.
	 */
	public getViewsByMode(): ViewsByMode[] {
		return CAMERA_MODES.map((mode) => ({ mode, views: this.getViews(mode) }));
	}

	/**
	 * Re-reads the views from the bridge.
	 * @returns The views.
	 */
	public async refreshViews(): Promise<CameraView[]> {
		try {
			const reply = await this.request<GetViewsReply>("get_views");
			if (reply && Array.isArray(reply.views)) {
				this.views = reply.views;
				this.aircraft = reply.metadata?.aircraft_readable ?? reply.metadata?.aircraft_folder ?? "";
				this.logger.info(`Loaded ${this.views.length} views (${this.aircraft || "no aircraft"})`);
				this.emit("viewsChanged", this.views);
			}
		} catch (err) {
			this.logger.warn(`get_views failed: ${(err as Error).message}`);
			// The bridge answers 503 "DLL not connected yet" while the flight loads.
			if (this.isReady) this.scheduleRefresh(RECONNECT_DELAY_MS);
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
	 * Switches to a view.
	 * @param guid GUID of the view.
	 * @returns Resolved when the bridge acknowledged the request.
	 */
	public setViewByGuid(guid: string): Promise<unknown> {
		return this.request("set_view_by_guid", { guid });
	}

	/**
	 * Starts the client; it reconnects until {@link ChasePlaneClient.stop} is called.
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
			// Must not keep the process alive once Stream Deck disconnects.
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

		// Replies nest their payload in { message, payload } envelopes; unwrap like the official client.
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
	 * Schedules a debounced views refresh.
	 * @param delayMs Delay before the refresh.
	 */
	private scheduleRefresh(delayMs = 250): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshViews();
		}, delayMs).unref();
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
