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

export function runDir(): string {
  return join(portcullisHome(), "run");
}

export function logPathFor(server: string): string {
  return join(logsDir(), `${slugify(server)}.jsonl`);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

// Server names come from the command line, so a name like ../../.bashrc must
// not be able to steer the log file out of the logs directory.
export function slugify(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  return cleaned === "" ? "server" : cleaned.slice(0, 100);
}
