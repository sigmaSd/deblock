// Sync-only code — no async functions, should pass.

export function readConfigSync(): string {
  return Deno.readTextFileSync("config.json");
}

export function writeConfigSync(data: string): void {
  Deno.writeTextFileSync("config.json", data);
}

export function compute(x: number): number {
  return x * x + 1;
}
