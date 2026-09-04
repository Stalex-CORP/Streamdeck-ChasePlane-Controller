import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

import { generateKeyImages } from "./scripts/key-images.mjs";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.stalexcorp.chaseplane.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		},
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		{
			// Generates imgs/actions/set-camera/keys/*.svg from src/images/*.png (see scripts/key-images.mjs).
			name: "key-images",
			buildStart: function () {
				const sources = generateKeyImages(
					path.resolve("src/images"),
					path.resolve(sdPlugin, "imgs/actions/set-camera/keys"),
				);
				sources.forEach((file) => this.addWatchFile(file));
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined,
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true,
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			},
		},
	],
	// Optional native accelerators of `ws`; never bundled.
	external: ["bufferutil", "utf-8-validate"],
};

export default config;
