import { parseArgs } from "@std/cli/parse-args";
import {
  type CallExpression,
  type FunctionLikeDeclaration,
  Project,
  SyntaxKind,
} from "npm:ts-morph";
import * as path from "@std/path";
import { expandGlob } from "@std/fs/expand-glob";

const parsed = parseArgs(Deno.args, {
  boolean: ["help"],
  string: ["exclude"],
  collect: ["exclude"],
  alias: { h: "help", e: "exclude" },
  default: { help: false, exclude: [] },
});

if (parsed.help) {
  console.log(`
Usage: deno run -A check-blocking.ts [options] [<files...>]

Looks for blocking Deno APIs inside asynchronous functions.

Options:
  -e, --exclude <pattern>    Exclude files matching the glob pattern.
  -h, --help                 Show this help message.
  `);
  Deno.exit(0);
}

async function getFiles() {
  let targets = parsed._.map(String);
  if (targets.length === 0) {
    const discovered = [];
    for await (
      const file of expandGlob("**/*.{ts,tsx}", {
        exclude: ["node_modules", "vendor", ".git", ...parsed.exclude],
      })
    ) {
      if (file.isFile) {
        discovered.push(path.relative(Deno.cwd(), file.path));
      }
    }
    targets = discovered;
  }
  return targets;
}

const project = new Project();
const files = await getFiles();
if (files.length === 0) {
  console.log("No files found to check.");
  Deno.exit(0);
}

console.log(`Analyzing ${files.length} files...`);
for (const file of files) {
  project.addSourceFileAtPath(file);
}

const allFunctions: FunctionLikeDeclaration[] = [];
for (const sourceFile of project.getSourceFiles()) {
  allFunctions.push(
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
  );
  allFunctions.push(
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
  );
  allFunctions.push(
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
  );
  allFunctions.push(
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  );
  allFunctions.push(...sourceFile.getDescendantsOfKind(SyntaxKind.Constructor));
  allFunctions.push(...sourceFile.getDescendantsOfKind(SyntaxKind.GetAccessor));
  allFunctions.push(...sourceFile.getDescendantsOfKind(SyntaxKind.SetAccessor));
}

function getFunctionName(func: FunctionLikeDeclaration): string {
  if (func.isKind(SyntaxKind.Constructor)) return "constructor";
  if (func.isKind(SyntaxKind.GetAccessor)) return `get ${func.getName()}`;
  if (func.isKind(SyntaxKind.SetAccessor)) return `set ${func.getName()}`;

  if ("getName" in func && typeof func.getName === "function") {
    const name = (func as any).getName?.();
    if (name) return name;
  }

  const variableDeclaration = func.getFirstAncestorByKind(
    SyntaxKind.VariableDeclaration,
  );
  if (variableDeclaration) {
    return variableDeclaration.getName();
  }

  const propertyAssignment = func.getFirstAncestorByKind(
    SyntaxKind.PropertyAssignment,
  );
  if (propertyAssignment) {
    return propertyAssignment.getName();
  }

  return "anonymous function";
}

function isAsyncFunction(func: FunctionLikeDeclaration): boolean {
  if ("isAsync" in func && typeof func.isAsync === "function") {
    return (func as any).isAsync();
  }
  return false;
}

function isNativeSyncBlocker(call: CallExpression): string | null {
  const text = call.getExpression().getText();
  if (text.startsWith("Deno.") && text.endsWith("Sync")) {
    return text;
  }
  // Add other native sync blockers if needed (e.g., fs.readSync from node)
  return null;
}

const blockingFunctions = new Map<
  FunctionLikeDeclaration,
  { reason: string; callText: string }
>();

// 1. Initial pass: find functions calling native blockers
for (const func of allFunctions) {
  const calls = func.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const native = isNativeSyncBlocker(call);
    if (native) {
      blockingFunctions.set(func, { reason: "native", callText: native });
      break;
    }
  }
}

// 2. Propagate blocking status through non-async functions
let changed = true;
while (changed) {
  changed = false;
  for (const func of allFunctions) {
    if (blockingFunctions.has(func)) continue;
    if (isAsyncFunction(func)) continue; // Only propagate through sync functions

    const calls = func.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const symbol = call.getExpression().getSymbol();
      if (!symbol) continue;
      const declarations = symbol.getDeclarations();
      for (const decl of declarations) {
        if (blockingFunctions.has(decl as FunctionLikeDeclaration)) {
          blockingFunctions.set(func, {
            reason: "calls_blocking_func",
            callText: call.getExpression().getText(),
          });
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
}

// 3. Report broken async functions
let foundIssues = false;
for (const func of allFunctions) {
  if (!isAsyncFunction(func)) continue;

  const calls = func.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const native = isNativeSyncBlocker(call);
    if (native) {
      report(func, call, native);
      foundIssues = true;
      continue; // Report all issues in the same function?
    }

    const symbol = call.getExpression().getSymbol();
    if (symbol) {
      const declarations = symbol.getDeclarations();
      for (const decl of declarations) {
        const blocker = blockingFunctions.get(decl as FunctionLikeDeclaration);
        if (blocker) {
          report(
            func,
            call,
            `${call.getExpression().getText()} (which is blocking)`,
          );
          foundIssues = true;
          break;
        }
      }
    }
  }
}

function report(
  func: FunctionLikeDeclaration,
  call: CallExpression,
  reason: string,
) {
  const sourceFile = func.getSourceFile();
  const lineChar = sourceFile.getLineAndColumnAtPos(call.getStart());
  const funcName = getFunctionName(func);
  console.log(`[BLOCKING ERROR] In async function '${funcName}':`);
  console.log(
    `  Location: ${sourceFile.getFilePath()}:${lineChar.line}:${lineChar.column}`,
  );
  console.log(`  Call: ${call.getText()}`);
  console.log(`  Reason: calls blocking API: ${reason}
`);
}

if (!foundIssues) {
  console.log("No blocking calls found in async functions.");
} else {
  Deno.exit(1);
}
