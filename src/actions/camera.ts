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

/** Settings persisted per key. `name` / `mode` are cached so the key renders before the simulator runs. */
type CameraSettings = {
	/** GUID of the selected view (written by the property inspector). */
	guid?: string;
	/** Cached display name. */
	name?: string;
	/** Cached camera mode. */
	mode?: CameraMode;
};

/** Message sent by the property inspector (sdpi-components data source protocol). */
type PropertyInspectorMessage = {
	/** Data source name. */
	event?: string;
	/** Refresh button pressed. */
	isRefresh?: boolean;
};

/** Visual state of a key image. */
type KeyImageState = "active" | "inactive" | "offline";

/** Last values sent to Stream Deck for a key (only changes are sent). */
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

/** Data source name of `<sdpi-select datasource>` in ui/camera.html. */
const CAMERAS_DATA_SOURCE = "getCameras";

/** Action states, as declared in the manifest. */
const State = { Inactive: 0, Active: 1 } as const;

/** Base name of the key images generated per mode (scripts/key-images.mjs). */
const MODE_IMAGE_NAME: Record<CameraMode, string> = {
	[CameraMode.Internal]: "internal",
	[CameraMode.External]: "external",
	[CameraMode.World]: "world",
};

/** Localization keys of the group labels (en.json / fr.json). */
const MODE_LABEL_KEY: Record<CameraMode, string> = {
	[CameraMode.Internal]: "Internal",
	[CameraMode.External]: "External",
	[CameraMode.World]: "World",
};

/**
 * Switches ChasePlane to a camera view. One key = one view; the key is "Active" while that view is
 * the current camera.
 */
@action({ UUID: "fr.stalexcorp.msfschaseplane.camera" })
export class CameraAction extends SingletonAction<CameraSettings> {
	/** Logger. */
	private readonly logger = streamDeck.logger.createScope("Camera");
	/** Last values sent to Stream Deck, by action identifier. */
	private readonly renderedById = new Map<string, RenderedState>();
	/** Settings of the visible keys, by action identifier. */
	private readonly settingsById = new Map<string, CameraSettings>();

	/**
	 * Initializes a new instance of the {@link CameraAction} class.
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
	public override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CameraSettings>): Promise<void> {
		if (!ev.action.isKey()) return;

		let settings = ev.payload.settings;
		this.settingsById.set(ev.action.id, settings);

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
	public override async onKeyDown(ev: KeyDownEvent<CameraSettings>): Promise<void> {
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
			// Reflect the change before the bridge confirms it through `cam_mode_set`.
			this.client.currentCamera = { ...this.client.currentCamera, preset_guid: guid };
			this.renderAll();
		} catch (err) {
			this.logger.error(`set_view_by_guid failed for ${guid}: ${(err as Error).message}`);
			await ev.action.showAlert();
		}
	}

	/** @inheritdoc */
	public override async onPropertyInspectorDidAppear(
		ev: PropertyInspectorDidAppearEvent<CameraSettings>,
	): Promise<void> {
		if (this.client.isReady) {
			await this.client.refreshViews();
		}
		this.sendStatus(ev.action.id);
	}

	/** @inheritdoc */
	public override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, CameraSettings>): Promise<void> {
		const message = ev.payload as PropertyInspectorMessage;
		if (message?.event !== CAMERAS_DATA_SOURCE) return;

		if (message.isRefresh && this.client.isReady) {
			await this.client.refreshViews();
		}
		this.sendCameras();
		this.sendStatus(ev.action.id);
	}

	/** @inheritdoc */
	public override onWillAppear(ev: WillAppearEvent<CameraSettings>): Promise<void> | void {
		if (!ev.action.isKey()) return;

		this.settingsById.set(ev.action.id, ev.payload.settings);
		this.renderedById.delete(ev.action.id);
		return this.render(ev.action, ev.payload.settings);
	}

	/** @inheritdoc */
	public override onWillDisappear(ev: WillDisappearEvent<CameraSettings>): void {
		this.settingsById.delete(ev.action.id);
		this.renderedById.delete(ev.action.id);
	}

	/**
	 * Updates the images, state and title of a key; only changed values are sent.
	 * @param key The key.
	 * @param settings The key's settings.
	 */
	private async render(key: KeyAction<CameraSettings>, settings: CameraSettings): Promise<void> {
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
	 * Re-renders every visible key.
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
	 * Sends the camera list to the property inspector, grouped by mode.
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
	 * @param actionId When specified, only if the property inspector belongs to this action.
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
	 * Returns settings enriched with the view's name and mode, or the same object when unchanged.
	 * @param settings Current settings.
	 * @param view Selected view.
	 * @returns Settings to persist.
	 */
	private withViewDetails(settings: CameraSettings, view: CameraView): CameraSettings {
		const name = getViewDisplayName(view);
		return settings.name === name && settings.mode === view.mode ? settings : { ...settings, name, mode: view.mode };
	}
}

/**
 * Wraps a name over up to three lines of ~10 characters. A user-defined title still takes precedence.
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
 * Path (relative to the plugin root) of a generated key image.
 * @param mode Camera mode.
 * @param state Visual state.
 * @returns Image path.
 */
function keyImage(mode: CameraMode, state: KeyImageState): string {
	return `imgs/actions/camera/keys/${MODE_IMAGE_NAME[mode]}-${state}.svg`;
}
