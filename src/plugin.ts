import streamDeck from "@elgato/streamdeck";

import { CameraAction } from "./actions/camera";
import { CinematicAction, FlashlightAction } from "./actions/toggle";
import { ChasePlaneClient } from "./chaseplane/client";

const client = new ChasePlaneClient({
	logger: streamDeck.logger.createScope("ChasePlane"),
	clientName: "Stream Deck",
});

// Actions must be registered before connecting.
streamDeck.actions.registerAction(new CameraAction(client));
streamDeck.actions.registerAction(new CinematicAction(client));
streamDeck.actions.registerAction(new FlashlightAction(client));

// Stream Deck stops a plugin by closing its connection and waiting for the process to exit.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => {
		client.stop();
		process.exit(0);
	});
}

streamDeck.connect();
client.start();
