/**
 * Generates the runtime key images of the "Camera" action: for each src/images/<mode>.png, three SVGs
 * (<mode>-inactive / -active / -offline) in <plugin>/imgs/actions/camera/keys/. Shipped with the plugin
 * and set by path, so Stream Deck caches them. Run by rollup or standalone: `node scripts/key-images.mjs`.
 */
import fs from "node:fs";
import path from "node:path";

export const MODES = /** @type {const} */ ([
	{ name: "internal", color: "#3b82f6" },
	{ name: "external", color: "#f59e0b" },
	{ name: "world", color: "#10b981" },
]);

const BACKGROUND = "#1f2126";
const OFFLINE = "#4b5563";

/**
 * Builds one key image.
 * @param {{ icon: string, color: string, state: "inactive" | "active" | "offline" }} o Image options.
 * @returns {string} SVG markup (72x72 viewBox, rendered at 144x144).
 */
export function buildKeySvg({ icon, color, state }) {
	const active = state === "active";
	const offline = state === "offline";
	const parts = [
		`<rect width="72" height="72" rx="8" fill="${active ? color : BACKGROUND}"/>`,
		active ? "" : `<rect x="0" y="0" width="72" height="5" fill="${offline ? OFFLINE : color}"/>`,
		`<image href="${icon}" x="16" y="9" width="40" height="40" opacity="${offline ? 0.35 : 1}" preserveAspectRatio="xMidYMid meet"/>`,
		active
			? `<rect x="3.5" y="3.5" width="65" height="65" rx="10" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.9"/>`
			: "",
		offline
			? `<circle cx="62" cy="14" r="5" fill="#ef4444"/><path d="M59 11l6 6M65 11l-6 6" stroke="#ffffff" stroke-width="1.6"/>`
			: "",
	];

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 72 72" width="144" height="144">` +
		parts.join("") +
		`</svg>`
	);
}

/**
 * Writes every key image, skipping files whose content is unchanged.
 * @param {string} srcDir Directory containing <mode>.png icons.
 * @param {string} outDir Output directory.
 * @returns {string[]} Source files (for watch mode).
 */
export function generateKeyImages(srcDir, outDir) {
	fs.mkdirSync(outDir, { recursive: true });
	const sources = [];

	for (const { name, color } of MODES) {
		const src = path.join(srcDir, `${name}.png`);
		sources.push(src);
		const icon = `data:image/png;base64,${fs.readFileSync(src).toString("base64")}`;

		for (const state of ["inactive", "active", "offline"]) {
			const svg = buildKeySvg({ icon, color, state });
			const file = path.join(outDir, `${name}-${state}.svg`);
			if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== svg) {
				writeFileForce(file, svg);
			}
		}
	}

	return sources;
}

/**
 * Writes a file, clearing a read-only flag if needed.
 * @param {string} file Destination.
 * @param {string} content Content.
 */
function writeFileForce(file, content) {
	try {
		fs.writeFileSync(file, content);
	} catch (err) {
		if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
		fs.chmodSync(file, 0o666);
		fs.rmSync(file, { force: true });
		fs.writeFileSync(file, content);
	}
}

if (
	process.argv[1] &&
	import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href.replace(/\\/g, "/")
) {
	generateKeyImages(
		path.resolve("src/images"),
		path.resolve("fr.stalexcorp.msfschaseplane.sdPlugin/imgs/actions/camera/keys"),
	);
	console.log("Key images generated.");
}
