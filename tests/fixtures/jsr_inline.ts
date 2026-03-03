// Inline JSR import (not in deno.json imports map).
// Uses @std/dotenv which is NOT listed in deno.json.

import { loadSync } from "jsr:@std/dotenv@0";

export async function loadConfig() {
  return loadSync();
}
