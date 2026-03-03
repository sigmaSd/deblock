// Direct Deno.*Sync calls inside async functions.

export async function readConfig() {
  const data = Deno.readTextFileSync("config.json");
  return JSON.parse(data);
}

export async function writeOutput(content: string) {
  Deno.writeTextFileSync("output.txt", content);
}

export async function checkFile(path: string) {
  const info = Deno.statSync(path);
  return info.isFile;
}
