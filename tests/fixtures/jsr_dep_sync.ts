// Blocking JSR dep call inside async function.

import { walkSync } from "@std/fs/walk";

export async function processFiles() {
  const entries = [];
  for (const entry of walkSync(".")) {
    entries.push(entry);
  }
  return entries;
}
