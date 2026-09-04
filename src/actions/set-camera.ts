import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import type { ChasePlaneClient } from "../chaseplane/client";
import { CameraMode, type CameraView, getViewDisplayName } from "../chaseplane/protocol";

/**
 * Settings persisted per key. `name` and `mode` cache the selected view's details so the key renders
 * correctly before the simulator is running.
 */
type SetCameraSettings = {
	/** GUID of the selected view (set by the property inspector). */
	guid?: string;
	/** Cached display name of the view. */
	name?: string;
	/** Cached camera mode of the view. */
	mode?: CameraMode;
};

/** Messages sent by the property inspector (sdpi-components data source protocol). */
type PropertyInspectorMessage = {
	/** Data source name. */
	event?: string;
	/** Whether the user pressed the refresh button. */
	isRefresh?: boolean;
};

/** Visual state of a key image. */
type KeyImageState = "active" | "inactive" | "offline";

/** What was last sent to Stream Deck for a key, to stay well under the recommended update rate. */
type RenderedState = {
	/** Image of the "Inactive" state. */
	inactiveImage?: string;
	/** Image of the "Active" state. */
	activeImage?: string;
	/** Current state. */
	state?: 0 | 1;
	/** Title. */
	title?: string;
};

/** Data source name used by `<sdpi-select datasource="...">` in ui/set-camera.html. */
const CAMERAS_DATA_SOURCE = "getCameras";

/** Action states, as declared in the manifest. */
const State = { Inactive: 0, Active: 1 } as const;

/** Base name of the key images generated for each mode (see scripts/key-images.mjs). */
const MODE_IMAGE_NAME: Record<CameraMode, string> = {
	[CameraMode.Internal]: "internal",
	[CameraMode.External]: "external",
	[CameraMode.World]: "world",
};

/** Localization keys of the data-source group labels (`Localization` section of en.json / fr.json). */
const MODE_LABEL_KEY: Record<CameraMode, string> = {
	[CameraMode.Internal]: "Internal",
	[CameraMode.External]: "External",
	[CameraMode.World]: "World",
};

/**
 * Switches ChasePlane to a camera view. One key represents one view; the key is in the "Active" state
 * while that view is the current camera.
 */
@action({ UUID: "com.stalexcorp.chaseplane.set-camera" })
export class SetCameraAction extends SingletonAction<SetCameraSettings> {
	/** Scoped logger. */
	private readonly logger = streamDeck.logger.createScope("SetCamera");
	/** Last values sent to Stream Deck, by action identifier. */
	private readonly renderedById = new Map<string, RenderedState>();
	/** Settings of the visible keys, by action identifier (event payloads are the reliable source). */
	private readonly settingsById = new Map<string, SetCameraSettings>();

	/**
	 * Initializes a new instance of the {@link SetCameraAction} class.
	 * @param client ChasePlane bridge client.
	 */
	constructor(private readonly client: ChasePlaneClient) {
		super();

		client.on("ready", () => this.renderAll());
		client.on("disconnected", () => {
			this.renderAll();
			this.sendStatus();
		});
		client.on("cameraChanged", () => {
			this.renderAll();
			this.sendStatus();
		});
		client.on("viewsChanged", () => {
			this.renderAll();
			this.sendCameras();
		});
	}

	/** @inheritdoc */
	public override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetCameraSettings>): Promise<void> {
		if (!ev.action.isKey()) return;

		let settings = ev.payload.settings;
		this.settingsById.set(ev.action.id, settings);

		// The property inspector only stores the GUID: cache the view's name and mode alongside it.
		const view = settings.guid ? this.client.findView(settings.guid) : undefined;
		if (view) {
			const cached = this.withViewDetails(settings, view);
			if (cached !== settings) {
				settings = cached;
				this.settingsById.set(ev.action.id, settings);
				await ev.action.setSettings(settings);
			}
		}

		await this.render(ev.action, settings);
		this.sendStatus();
	}

	/** @inheritdoc */
	public override async onKeyDown(ev: KeyDownEvent<SetCameraSettings>): Promise<void> {
		const { guid } = ev.payload.settings;
		if (!guid) {
			this.logger.warn("Key pressed but no camera view is selected");
			return ev.action.showAlert();
		}

		if (!this.client.isReady) {
			this.logger.warn("Key pressed but the ChasePlane bridge is not connected");
			return ev.action.showAlert();
		}

		try {
			await this.client.setViewByGuid(guid);
			// The bridge confirms through `cam_mode_set`; reflect the change immediately for a snappy key.
			this.client.currentCamera = { ...this.client.currentCamera, preset_guid: guid };
			this.renderAll();
		} catch (err) {
			this.logger.error(`set_view_by_guid failed for ${guid}: ${(err as Error).message}`);
			await ev.action.showAlert();
		}
	}

	/** @inheritdoc */
	public override async onPropertyInspectorDidAppear(
		ev: PropertyInspectorDidAppearEvent<SetCameraSettings>,
	): Promise<void> {
		if (this.client.isReady) {
			await this.client.refreshViews();
		}
		this.sendStatus(ev.action.id);
	}

	/** @inheritdoc */
	public override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SetCameraSettings>): Promise<void> {
		const message = ev.payload as PropertyInspectorMessage;
		if (message?.event !== CAMERAS_DATA_SOURCE) return;

		if (message.isRefresh && this.client.isReady) {
			await this.client.refreshViews();
		}
		this.sendCameras();
		this.sendStatus(ev.action.id);
	}

	/** @inheritdoc */
	public override onWillAppear(ev: WillAppearEvent<SetCameraSettings>): Promise<void> | void {
		if (!ev.action.isKey()) return;

		this.settingsById.set(ev.action.id, ev.payload.settings);
		this.renderedById.delete(ev.action.id);
		return this.render(ev.action, ev.payload.settings);
	}

	/** @inheritdoc */
	public override onWillDisappear(ev: WillDisappearEvent<SetCameraSettings>): void {
		this.settingsById.delete(ev.action.id);
		this.renderedById.delete(ev.action.id);
	}

	/**
	 * Updates the images, state and title of a key. Only changed values are sent to Stream Deck.
	 * @param key The key.
	 * @param settings The key's settings.
	 */
	private async render(key: KeyAction<SetCameraSettings>, settings: SetCameraSettings): Promise<void> {
		const view = settings.guid ? this.client.findView(settings.guid) : undefined;
		const mode = view?.mode ?? settings.mode;
		const connected = this.client.isReady;
		const active = connected && !!settings.guid && this.client.activeGuid === settings.guid;

		const next: RenderedState = {
			inactiveImage: mode === undefined ? undefined : keyImage(mode, connected ? "inactive" : "offline"),
			activeImage: mode === undefined ? undefined : keyImage(mode, "active"),
			state: active ? State.Active : State.Inactive,
			title: formatTitle(view ? getViewDisplayName(view) : (settings.name ?? "")),
		};

		const prev = this.renderedById.get(key.id) ?? {};
		this.renderedById.set(key.id, next);

		const commands: Promise<void>[] = [];
		if (next.inactiveImage !== prev.inactiveImage)
			commands.push(key.setImage(next.inactiveImage, { state: State.Inactive }));
		if (next.activeImage !== prev.activeImage) commands.push(key.setImage(next.activeImage, { state: State.Active }));
		if (next.state !== prev.state) commands.push(key.setState(next.state ?? State.Inactive));
		if (next.title !== prev.title) commands.push(key.setTitle(next.title));
		await Promise.all(commands);
	}

	/**
	 * Re-renders every visible key of this action.
	 */
	private renderAll(): void {
		for (const key of this.actions) {
			if (!key.isKey()) continue;
			const settings = this.settingsById.get(key.id);
			if (settings) {
				void this.render(key, settings);
			}
		}
	}

	/**
	 * Sends the camera list to the property inspector, grouped by mode (data source format).
	 */
	private sendCameras(): void {
		const items = this.client
			.getViewsByMode()
			.filter(({ views }) => views.length > 0)
			.map(({ mode, views }) => ({
				label: streamDeck.i18n.translate(MODE_LABEL_KEY[mode]),
				children: views.map((view) => ({ label: getViewDisplayName(view), value: view.guid })),
			}));

		void streamDeck.ui.sendToPropertyInspector({ event: CAMERAS_DATA_SOURCE, items });
	}

	/**
	 * Sends the connection status to the property inspector.
	 * @param actionId When specified, the status is only sent if the property inspector belongs to this action.
	 */
	private sendStatus(actionId?: string): void {
		const current = streamDeck.ui.action;
		if (!current || (actionId !== undefined && current.id !== actionId)) return;

		const settings = this.settingsById.get(current.id);
		void streamDeck.ui.sendToPropertyInspector({
			event: "status",
			connected: this.client.isReady,
			aircraft: this.client.aircraft,
			isActive: !!settings?.guid && this.client.activeGuid === settings.guid,
		} satisfies JsonObject);
	}

	/**
	 * Returns settings enriched with the view's display name and mode, or the same object when unchanged.
	 * @param settings Current settings.
	 * @param view Selected view.
	 * @returns Settings to persist.
	 */
	private withViewDetails(settings: SetCameraSettings, view: CameraView): SetCameraSettings {
		const name = getViewDisplayName(view);
		return settings.name === name && settings.mode === view.mode ? settings : { ...settings, name, mode: view.mode };
	}
}

/**
 * Wraps a camera name over up to three lines so it fits on a key. Users can still override the title
 * from the Stream Deck app, in which case their title takes precedence.
 * @param name Camera name.
 * @returns Title text.
 */
function formatTitle(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length <= 10) return trimmed;

	const lines: string[] = [];
	let current = "";
	for (const word of trimmed.split(/\s+/)) {
		if (current && `${current} ${word}`.length > 10) {
			lines.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) lines.push(current);

	return lines.slice(0, 3).join("\n");
}

/**
 * Gets the path (relative to the plugin root) of a generated key image.
 * @param mode Camera mode.
 * @param state Visual state.
 * @returns Image path.
 */
function keyImage(mode: CameraMode, state: KeyImageState): string {
	return `imgs/actions/set-camera/keys/${MODE_IMAGE_NAME[mode]}-${state}.svg`;
}
