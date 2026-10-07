// The CLI version every command shown on the site pins. Pinned on purpose: `npx` would otherwise
// fetch whatever is newest, and a compromised release would receive secrets on the next pull.
// Bump together with cli/package.json; test/shared/pinned-version.test.ts fails if they drift.
export const STUBS_CLI_VERSION = "0.3.0";
export const NPX_STUBS = `npx -y @talix/stubs@${STUBS_CLI_VERSION}`;
