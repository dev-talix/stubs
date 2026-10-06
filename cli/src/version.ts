import { readFileSync } from "node:fs";

/** Read from cli/package.json, which sits one level above both src/ and dist/. Null if unreadable. */
export function readPackageVersion(): string | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch {
    // Fall through to null.
  }
  return null;
}

/** For display only: a missing version must never stop the CLI. */
export function packageVersion(): string {
  return readPackageVersion() ?? "0.0.0";
}
