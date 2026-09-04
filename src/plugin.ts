import streamDeck from "@elgato/streamdeck";

import { SetCameraAction } from "./actions/set-camera";
import { ChasePlaneClient } from "./chaseplane/client";

// Log level defaults to DEBUG in development and INFO in production; trace would log every bridge frame.
const client = new ChasePlaneClient({
	logger: streamDeck.logger.createScope("ChasePlane"),
	clientName: "Stream Deck",
});

// Register all actions before connecting to Stream Deck.
streamDeck.actions.registerAction(new SetCameraAction(client));

// Stream Deck stops a plugin by closing its connection and waiting for the process to exit.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => {
		client.stop();
		process.exit(0);
	});
}

streamDeck.connect();
client.start();
