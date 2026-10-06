import { readFileSync } from "node:fs";

/** Read from cli/package.json, which sits one level above both src/ and dist/. */
export function packageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch {
    // Fall through: a missing version must never stop the CLI.
  }
  return "0.0.0";
}
