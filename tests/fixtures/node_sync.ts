// Node.js builtin sync calls inside async functions.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export async function loadConfig() {
  const raw = readFileSync("config.json", "utf-8");
  return JSON.parse(raw);
}

export async function runCommand() {
  return execSync("echo hello");
}
