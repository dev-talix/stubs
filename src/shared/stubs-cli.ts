// The CLI version every command shown on the site pins, read from the package itself so the
// site can't drift from what's published. Pinned on purpose: `npx` would otherwise fetch
// whatever is newest, and a compromised release would receive secrets on the next pull.
//
// index.html and src/llms.txt carry a {{STUBS_CLI_VERSION}} placeholder that vite.config.ts
// fills from the same file. The markdown docs need literal versions (GitHub and npm render
// them as-is); `pnpm sync-version` rewrites those, and test/shared/pinned-version.test.ts
// fails if any of them drift.
import { version } from "../../cli/package.json";

export const STUBS_CLI_VERSION: string = version;
export const NPX_STUBS = `npx -y @talix/stubs@${STUBS_CLI_VERSION}`;
