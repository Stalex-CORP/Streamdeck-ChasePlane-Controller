import streamDeck, {
	action,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { ChasePlaneClient } from "../chaseplane/client";

/** Visual state of a key image. */
type KeyImageState = "active" | "inactive" | "offline";

/** Last values sent to Stream Deck for a key (only changes are sent). */
type RenderedState = {
	/** Image of the "Off" state. */
	offImage?: string;
	/** Current state. */
	state?: 0 | 1;
};

/** Action states, as declared in the manifest. */
const State = { Off: 0, On: 1 } as const;

/**
 * Base of the on / off actions: the key is "On" while the ChasePlane feature is enabled, and shows the
 * offline image while the bridge is not connected.
 */
abstract class ToggleAction extends SingletonAction<JsonObject> {
	/** Last values sent to Stream Deck, by action identifier. */
	private readonly renderedById = new Map<string, RenderedState>();

	/**
	 * Initializes a new instance of the {@link ToggleAction} class.
	 * @param client ChasePlane bridge client.
	 * @param imageName Base name of the key images (scripts/key-images.mjs).
	 * @param logger Logger.
	 */
	protected constructor(
		protected readonly client: ChasePlaneClient,
		private readonly imageName: string,
		protected readonly logger = streamDeck.logger.createScope(imageName),
	) {
		super();
		for (const event of ["ready", "disconnected", "cameraChanged", "flashlightChanged"] as const) {
			client.on(event, () => this.renderAll());
		}
	}

	/**
	 * Whether the feature is currently on.
	 * @returns `true` when on.
	 */
	protected abstract get isOn(): boolean;

	/** @inheritdoc */
	public override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		if (!this.client.isReady) {
			this.logger.warn("Key pressed but the ChasePlane bridge is not connected");
			return ev.action.showAlert();
		}

		try {
			await this.toggle();
			this.renderAll();
		} catch (err) {
			this.logger.error(`Toggle failed: ${(err as Error).message}`);
			await ev.action.showAlert();
		}
	}

	/** @inheritdoc */
	public override onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> | void {
		if (!ev.action.isKey()) return;

		this.renderedById.delete(ev.action.id);
		return this.render(ev.action);
	}

	/** @inheritdoc */
	public override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		this.renderedById.delete(ev.action.id);
	}

	/**
	 * Toggles the feature on the bridge.
	 * @returns Resolved when the bridge acknowledged the request.
	 */
	protected abstract toggle(): Promise<unknown>;

	/**
	 * Path (relative to the plugin root) of a generated key image.
	 * @param state Visual state.
	 * @returns Image path.
	 */
	private keyImage(state: KeyImageState): string {
		return `imgs/actions/camera/keys/${this.imageName}-${state}.svg`;
	}

	/**
	 * Updates the image and state of a key; only changed values are sent.
	 * @param key The key.
	 */
	private async render(key: KeyAction<JsonObject>): Promise<void> {
		const connected = this.client.isReady;
		const next: RenderedState = {
			offImage: this.keyImage(connected ? "inactive" : "offline"),
			state: connected && this.isOn ? State.On : State.Off,
		};

		const prev = this.renderedById.get(key.id) ?? {};
		this.renderedById.set(key.id, next);

		const commands: Promise<void>[] = [];
		if (next.offImage !== prev.offImage) commands.push(key.setImage(next.offImage, { state: State.Off }));
		if (prev.state === undefined) commands.push(key.setImage(this.keyImage("active"), { state: State.On }));
		if (next.state !== prev.state) commands.push(key.setState(next.state ?? State.Off));
		await Promise.all(commands);
	}

	/**
	 * Re-renders every visible key.
	 */
	private renderAll(): void {
		for (const key of this.actions) {
			if (key.isKey()) void this.render(key);
		}
	}
}

/**
 * Toggles ChasePlane cinematic mode.
 */
@action({ UUID: "fr.stalexcorp.msfschaseplane.cinematic" })
export class CinematicAction extends ToggleAction {
	/**
	 * Initializes a new instance of the {@link CinematicAction} class.
	 * @param client ChasePlane bridge client.
	 */
	constructor(client: ChasePlaneClient) {
		super(client, "cinematic");
	}

	/** @inheritdoc */
	protected get isOn(): boolean {
		return this.client.cinematicEnabled;
	}

	/** @inheritdoc */
	protected toggle(): Promise<unknown> {
		return this.client.toggleCinematic();
	}
}

/**
 * Toggles the ChasePlane flashlight.
 */
@action({ UUID: "fr.stalexcorp.msfschaseplane.flashlight" })
export class FlashlightAction extends ToggleAction {
	/**
	 * Initializes a new instance of the {@link FlashlightAction} class.
	 * @param client ChasePlane bridge client.
	 */
	constructor(client: ChasePlaneClient) {
		super(client, "flashlight");
	}

	/** @inheritdoc */
	protected get isOn(): boolean {
		return this.client.flashlightEnabled;
	}

	/** @inheritdoc */
	protected toggle(): Promise<unknown> {
		return this.client.toggleFlashlight();
	}
}
