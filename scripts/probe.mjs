#!/usr/bin/env node
/**
 * Quick protocol probe against the ChasePlane bridge (no Stream Deck needed).
 *   node scripts/probe.mjs            -> connect, dump initialized + get_views, exit
 *   node scripts/probe.mjs <guid>     -> same, then set_view_by_guid(<guid>)
 *   node scripts/probe.mjs --watch    -> stay connected and print every push event
 */
import WebSocket from "ws";

const url = process.env.CP_WS ?? "ws://localhost:8652";
const arg = process.argv[2];
const watch = arg === "--watch";
const guidToSet = arg && !watch ? arg : null;

const ws = new WebSocket(url);
const pending = new Map();
const short = (o) => JSON.stringify(o, null, 2).slice(0, 4000);

function request(command, payload = {}) {
	return new Promise((resolve, reject) => {
		const id = `${command}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ message: "api_request", request_id: id, command, payload }));
		setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error("timeout"))), 10000);
	});
}

ws.on("open", () => {
	console.log(`[open] ${url} -> api_connect`);
	ws.send(JSON.stringify({ message: "api_connect", payload: { client_name: "probe" } }));
});
ws.on("error", (e) => console.error("[error]", e.message));
ws.on("close", (c) => {
	console.log("[close]", c);
	process.exit(0);
});

ws.on("message", async (raw) => {
	const s = raw.toString();
	if (s === "PING" || s === "PING_BRIDGE") return;
	let m;
	try {
		m = JSON.parse(s);
	} catch {
		return console.log("[raw]", s.slice(0, 200));
	}

	if (m.message === "api_reply") {
		const p = pending.get(m.request_id);
		if (p) {
			pending.delete(m.request_id);
			m.status === 200 ? p.resolve(m.payload) : p.reject(new Error(`${m.error} (${m.status})`));
		}
		return;
	}
	console.log(`[event] ${m.message}`, short(m.payload));

	if (m.message === "initialized") {
		try {
			const views = await request("get_views");
			console.log("[get_views]", short(views));
			const list = views?.views ?? views?.payload?.views ?? [];
			for (const v of list) console.log(`  mode=${v.mode} ${v.guid}  ${v.name}  ${v.view_type ?? ""}`);
			if (guidToSet) console.log("[set_view_by_guid]", short(await request("set_view_by_guid", { guid: guidToSet })));
		} catch (e) {
			console.error("[request failed]", e.message);
		}
		if (!watch) setTimeout(() => ws.close(), 1500);
	}
});
