/**
 * Generates the key images in <plugin>/imgs/actions/camera/keys/: for each src/images/<mode>.png and each
 * toggle glyph src/images/<toggle>.svg, <name>-inactive / -active / -offline (set by path at runtime), plus the manifest
 * state images default-inactive / default-active built from the ChasePlane glyph (imgs/plugin/category-icon.svg,
 * shown while no view is selected). Run by rollup or standalone: `node scripts/key-images.mjs`.
 */
import fs from "node:fs";
import path from "node:path";

export const MODES = /** @type {const} */ ([
	{ name: "internal", color: "#3b82f6" },
	{ name: "external", color: "#f59e0b" },
	{ name: "world", color: "#10b981" },
]);

/** Toggle actions (src/images/<name>.svg, white glyph on transparent background). */
export const TOGGLES = /** @type {const} */ ([
	{ name: "cinematic", color: "#a855f7" },
	{ name: "flashlight", color: "#facc15", activeIcon: "flashlight-on" },
]);

const BACKGROUND = "#1f2126";
const DEFAULT_COLOR = "#9ca3af";
const OFFLINE = "#4b5563";

/** Red badge with a crossed-out wifi glyph (connection lost), top-right corner. */
const OFFLINE_BADGE =
	`<g transform="translate(61 14)">` +
	`<circle r="6" fill="#ef4444"/>` +
	`<g fill="none" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round">` +
	`<path d="M-4.2 -0.6A5.9 5.9 0 0 1 4.2 -0.6"/>` +
	`<path d="M-2.5 1.2A3.5 3.5 0 0 1 2.5 1.2"/>` +
	`</g>` +
	`<circle cy="3.2" r="0.9" fill="#ffffff"/>` +
	`<path d="M-3.6 -3.6L3.6 3.6" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round"/>` +
	`<path d="M-3.6 -3.6L3.6 3.6" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round"/>` +
	`</g>`;

/**
 * Builds one key image.
 * @param {{ icon: string, color: string, state: "inactive" | "active" | "offline", size?: number }} o Image options
 * (`size`: icon box in viewBox units, centered on the 44x44 area used by the mode icons).
 * @returns {string} SVG markup (72x72 viewBox, rendered at 144x144).
 */
export function buildKeySvg({ icon, color, state, size = 44 }) {
	const active = state === "active";
	const offline = state === "offline";
	const offset = (44 - size) / 2;
	const parts = [
		`<rect width="72" height="72"/>`,
		`<rect x="0" y="0" width="72" height="5" fill="${color}" fill-opacity="${active ? 1 : 0}"/>`,
		`<image href="${icon}" x="${13.5 + offset}" y="${8 + offset}" width="${size}" height="${size}" opacity="${offline ? 0.5 : 1}" preserveAspectRatio="xMidYMid meet"/>`,
		offline ? OFFLINE_BADGE : "",
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

	const glyph = path.join(outDir, "..", "..", "..", "plugin", "category-icon.svg");
	sources.push(glyph);
	const glyphIcon = `data:image/svg+xml;base64,${fs.readFileSync(glyph).toString("base64")}`;
	for (const state of ["inactive", "active"]) {
		writeIfChanged(
			path.join(outDir, `default-${state}.svg`),
			buildKeySvg({ icon: glyphIcon, color: DEFAULT_COLOR, state, size: 34 }),
		);
	}

	const dataUri = (file) => {
		const src = path.join(srcDir, file);
		sources.push(src);
		const mime = file.endsWith(".svg") ? "image/svg+xml" : "image/png";
		return `data:${mime};base64,${fs.readFileSync(src).toString("base64")}`;
	};
	const icons = [
		...MODES.map((m) => ({ ...m, icon: dataUri(`${m.name}.png`), size: 44 })),
		...TOGGLES.map((t) => ({
			...t,
			icon: dataUri(`${t.name}.svg`),
			activeIcon: t.activeIcon ? dataUri(`${t.activeIcon}.svg`) : undefined,
			size: 30,
		})),
	];
	for (const { name, color, icon, activeIcon, size } of icons) {
		for (const state of ["inactive", "active", "offline"]) {
			const svg = buildKeySvg({ icon: state === "active" ? (activeIcon ?? icon) : icon, color, state, size });
			writeIfChanged(path.join(outDir, `${name}-${state}.svg`), svg);
		}
	}

	return sources;
}

/**
 * Writes a file when its content changed.
 * @param {string} file Destination.
 * @param {string} content Content.
 */
function writeIfChanged(file, content) {
	if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) {
		writeFileForce(file, content);
	}
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
		path.resolve("fr.stalexcorp.chaseplane-controller.sdPlugin/imgs/actions/camera/keys"),
	);
	console.log("Key images generated.");
}
