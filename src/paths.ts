import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Package root. This file compiles to dist/src/paths.js, two levels below the root. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function packagePath(...parts: string[]): string {
  return [PACKAGE_ROOT.replace(/\/$/, ""), ...parts].join("/");
}

let cachedVersion: string | undefined;
export function toolVersion(): string {
  if (!cachedVersion) {
    const pkg = JSON.parse(readFileSync(packagePath("package.json"), "utf8")) as { version: string };
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}
