#!/usr/bin/env node
/**
 * Regenerate `SHA256SUMS.txt` for the binaries shipped with this package.
 *
 * The launcher exe is a prebuilt artifact, so the package pins every binary it ships with a
 * SHA-256 line that the test suite re-verifies against the actual bytes. Run this after
 * rebuilding `DSHLauncher.exe`:
 *
 *   node assets/build-checksums.mjs
 *
 * @module dsh-desktop/build-checksums
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Binaries covered by the checksum manifest (same names the installer copies). */
export const CHECKSUM_ASSETS = [
  "DSHLauncher.exe",
  "Microsoft.Web.WebView2.Core.dll",
  "Microsoft.Web.WebView2.WinForms.dll",
  "WebView2Loader.dll",
  "DSHLauncher.ico",
  "DSHLauncher-debug.ico"
];

/**
 * Compute the manifest lines for one directory.
 * @param dir - directory holding the binaries (defaults to the packaged assets).
 * @returns `["<sha256>  <name>", ...]`.
 */
export function checksumLines(dir = HERE) {
  return CHECKSUM_ASSETS.map((name) => {
    const hash = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    return `${hash}  ${name}`;
  });
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const lines = checksumLines();
  writeFileSync(join(HERE, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
}
