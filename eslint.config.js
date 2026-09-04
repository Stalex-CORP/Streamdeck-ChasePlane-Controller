import { config } from "@elgato/eslint-config";

export default [...config.recommended, { ignores: ["**/*.sdPlugin/**", "dist/**", "scripts/**"] }];
