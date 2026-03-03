import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";

const MAIN = path.join(import.meta.dirname!, "..", "main.ts");
const FIXTURES = path.join(import.meta.dirname!, "fixtures");

/** Run deblock on a fixture file and return { code, stdout, stderr }. */
async function run(
  fixture: string,
  extraArgs: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const filePath = path.join(FIXTURES, fixture);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, ...extraArgs, filePath],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// ---------------------------------------------------------------------------
// Clean code — no issues expected
// ---------------------------------------------------------------------------

Deno.test("clean code passes", async () => {
  const { code, stdout } = await run("clean.ts");
  assertEquals(code, 0);
  assert(stdout.includes("No blocking calls found"), stdout);
});

Deno.test("sync-only code passes (no async functions)", async () => {
  const { code, stdout } = await run("sync_only.ts");
  assertEquals(code, 0);
  assert(stdout.includes("No blocking calls found"), stdout);
});

// ---------------------------------------------------------------------------
// Direct Deno.*Sync calls in async functions
// ---------------------------------------------------------------------------

Deno.test("detects Deno.*Sync in async functions", async () => {
  const { code, stdout } = await run("deno_sync.ts");
  assertEquals(code, 1);
  assert(stdout.includes("Deno.readTextFileSync"), stdout);
  assert(stdout.includes("Deno.writeTextFileSync"), stdout);
  assert(stdout.includes("Deno.statSync"), stdout);
});

// ---------------------------------------------------------------------------
// Node.js builtin sync calls
// ---------------------------------------------------------------------------

Deno.test("detects node: builtin sync calls in async functions", async () => {
  const { code, stdout } = await run("node_sync.ts");
  assertEquals(code, 1);
  assert(stdout.includes("readFileSync"), stdout);
  assert(stdout.includes("execSync"), stdout);
});

// ---------------------------------------------------------------------------
// JSR dependency blocking calls
// ---------------------------------------------------------------------------

Deno.test("detects blocking calls from JSR deps", async () => {
  const { code, stdout } = await run("jsr_dep_sync.ts");
  assertEquals(code, 1);
  assert(stdout.includes("walkSync"), stdout);
  // Should show the root cause chain
  assert(stdout.includes("Deno.readDirSync"), stdout);
});

Deno.test("detects blocking calls from inline jsr: imports", async () => {
  const { code, stdout } = await run("jsr_inline.ts");
  assertEquals(code, 1);
  assert(stdout.includes("loadSync"), stdout);
  assert(stdout.includes("Deno.readTextFileSync"), stdout);
});

// ---------------------------------------------------------------------------
// Propagation through sync call chain
// ---------------------------------------------------------------------------

Deno.test("propagates blocking through sync function chain", async () => {
  const { code, stdout } = await run("propagation.ts");
  assertEquals(code, 1);
  assert(stdout.includes("parseConfig"), stdout);
  // Root cause should trace back to Deno.readTextFileSync
  assert(stdout.includes("Deno.readTextFileSync"), stdout);
});

Deno.test("propagates blocking through arrow functions assigned to variables", async () => {
  const { code, stdout } = await run("arrow_propagation.ts");
  assertEquals(code, 1);
  assert(stdout.includes("processData"), stdout);
  assert(stdout.includes("Deno.readTextFileSync"), stdout);
});

// ---------------------------------------------------------------------------
// --fix flag
// ---------------------------------------------------------------------------

Deno.test("--fix converts Deno.*Sync to await async equivalents", async () => {
  // Work on a temp copy so the fixture is not modified
  const src = path.join(FIXTURES, "deno_sync.ts");
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.copyFile(src, tmp);

  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", MAIN, "--fix", tmp],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);

    // Should exit 0 after fixing
    assertEquals(output.code, 0, stdout);
    assert(stdout.includes("Fixed 3 issue(s)"), stdout);

    // Read back the fixed file
    const fixed = await Deno.readTextFile(tmp);
    assert(fixed.includes("await Deno.readTextFile("), fixed);
    assert(fixed.includes("await Deno.writeTextFile("), fixed);
    assert(fixed.includes("await Deno.stat("), fixed);
    // Sync variants should be gone
    assert(!fixed.includes("readTextFileSync"), fixed);
    assert(!fixed.includes("writeTextFileSync"), fixed);
    assert(!fixed.includes("statSync"), fixed);

    // Re-run deblock on the fixed file — should be clean
    const cmd2 = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", MAIN, tmp],
      stdout: "piped",
      stderr: "piped",
    });
    const output2 = await cmd2.output();
    const stdout2 = new TextDecoder().decode(output2.stdout);
    assertEquals(output2.code, 0, stdout2);
    assert(stdout2.includes("No blocking calls found"), stdout2);
  } finally {
    await Deno.remove(tmp);
  }
});
