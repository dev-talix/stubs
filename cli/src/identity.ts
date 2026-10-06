// R8: this machine's identity for locked stubs. Same model as an SSH key: one file with tight
// permissions, no keychain, no passphrase. The secret is never printed; only the public id is.

import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { generateIdentity, publicIdFromSecret, type Identity } from "../../src/core/lock";
import { isNotFound, writeFileAtomic } from "./env-file";
import { errorCode, fail, type Failure } from "./result";

export type { Identity } from "../../src/core/lock";

export interface IdentityDeps {
  env: Record<string, string | undefined>;
  home: string;
}

const HEADER = "# stubs identity v1";

/** `$XDG_CONFIG_HOME/stubs`, or `~/.config/stubs`. */
export function configDir(deps: IdentityDeps): string {
  const xdg = deps.env.XDG_CONFIG_HOME;
  // The XDG spec says relative values are invalid and must be ignored.
  return join(xdg && isAbsolute(xdg) ? xdg : join(deps.home, ".config"), "stubs");
}

export function identityPath(deps: IdentityDeps): string {
  return join(configDir(deps), "identity");
}

/** Where pulled values go when the target can't be written after a claim. */
export function recoveryDir(deps: IdentityDeps): string {
  return join(configDir(deps), "recovered");
}

/** The identity, null if there isn't one, or a failure that names the file but not its contents. */
export async function loadIdentity(deps: IdentityDeps): Promise<Identity | null | Failure> {
  const path = identityPath(deps);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    return fail("error", `Couldn't read the identity at ${path} (${errorCode(error)}).`);
  }
  const [header, secret = ""] = text.split(/\r?\n/);
  const publicId = header === HEADER ? await publicIdFromSecret(secret.trim()) : null;
  if (!publicId) {
    return fail("error", `${path} isn't a valid stubs identity. Move it aside and run \`stubs init\`.`);
  }
  return { secret: secret.trim(), publicId };
}

export type InitSuccess = { ok: true; publicId: string; created: true };

export async function createIdentity(deps: IdentityDeps, options: { force?: boolean } = {}): Promise<InitSuccess | Failure> {
  const path = identityPath(deps);
  const dir = dirname(path);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory's mode alone.
    await chmod(dir, 0o700);
  } catch (error) {
    return fail("error", `Couldn't create ${dir} (${errorCode(error)}).`);
  }

  const identity = await generateIdentity();
  const content = Buffer.from(`${HEADER}\n${identity.secret}\n`, "utf8");
  try {
    if (options.force) {
      await writeFileAtomic(path, content);
      await chmod(path, 0o600);
    } else {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return fail(
        "invalid",
        `An identity already exists at ${path}. Run \`stubs id\` to see it, or pass --force to replace it (stubs already locked to the old id will no longer open).`,
      );
    }
    return fail("error", `Couldn't write ${path} (${errorCode(error)}).`);
  }
  return { ok: true, publicId: identity.publicId, created: true };
}
