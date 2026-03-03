// Deno.*Sync inside nested callbacks — should NOT be auto-fixable.

export async function handler() {
  // Direct — fixable
  Deno.writeTextFileSync("direct.txt", "ok");

  // Nested in .then() callback — NOT fixable
  await fetch("http://example.com")
    .then((r) => r.bytes())
    .then((bytes) => Deno.writeFileSync("nested.bin", bytes));

  // Nested in .map() — NOT fixable
  const files = ["a.txt", "b.txt"];
  files.map((f) => Deno.readTextFileSync(f));
}
