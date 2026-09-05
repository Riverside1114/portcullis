/**
 * Where Portcullis keeps its state.
 *
 * Everything lives under a single directory in the user's home. Nothing is
 * written elsewhere on the system, and nothing leaves the machine — design rule
 * 3 in the README. `PORTCULLIS_HOME` overrides the location, which is how tests
 * avoid touching a developer's real logs.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export function portcullisHome(): string {
  const override = process.env["PORTCULLIS_HOME"];
  return override ? resolve(override) : join(homedir(), ".portcullis");
}

export function logsDir(): string {
  return join(portcullisHome(), "logs");
}

/** Local sockets for the analyzer sidecar and the approval front end. */
export function runDir(): string {
  return join(portcullisHome(), "run");
}

export function logPathFor(server: string): string {
  return join(logsDir(), `${slugify(server)}.jsonl`);
}

export async function ensureDir(path: string): Promise<void> {
  // 0o700: the audit log is a transcript of everything an agent touched,
  // including file contents and API responses. On a shared machine it should
  // not be world-readable. Windows ignores the mode and uses inherited ACLs.
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * Makes a server name safe to use as a filename.
 *
 * Server names come from the command line and can contain path separators — a
 * name like `../../.bashrc` must not be able to steer the log file out of the
 * logs directory.
 */
export function slugify(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  return cleaned === "" ? "server" : cleaned.slice(0, 100);
}
