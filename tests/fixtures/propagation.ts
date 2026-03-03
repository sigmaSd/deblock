// Sync function that calls a blocker, called from async — tests propagation.

function readConfigSync(): string {
  return Deno.readTextFileSync("config.json");
}

function parseConfig(): Record<string, unknown> {
  return JSON.parse(readConfigSync());
}

export async function getConfig() {
  return parseConfig();
}
