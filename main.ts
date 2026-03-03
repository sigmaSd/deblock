import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandGlob } from "@std/fs/expand-glob";
import { bold, cyan, gray, green, magenta, red, yellow } from "@std/fmt/colors";
import {
  type CallExpression,
  type FunctionLikeDeclaration,
  Node,
  Project,
  SyntaxKind,
  ts,
} from "ts-morph";

const parsed = parseArgs(Deno.args, {
  boolean: ["help", "no-deps", "all", "fix"],
  string: ["exclude"],
  collect: ["exclude"],
  alias: { h: "help", e: "exclude" },
  default: {
    help: false,
    exclude: [],
    "no-deps": false,
    all: false,
    fix: false,
  },
});

const noDeps = parsed["no-deps"] as boolean;
const reportAll = parsed["all"] as boolean;
const fixMode = parsed["fix"] as boolean;

if (parsed.help) {
  console.log(`
${bold("Usage:")} deno run -A check-blocking.ts [options] [<files...>]

Looks for blocking Deno APIs inside asynchronous functions.

${bold("Options:")}
  -e, --exclude <pattern>    Exclude files matching the glob pattern.
      --no-deps              Skip dependency scanning for a faster check.
      --all                  Also report issues found in dependencies.
      --fix                  Auto-fix direct Deno.*Sync calls in async functions.
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

// ---------------------------------------------------------------------------
// Dependency resolution via `deno info`
// ---------------------------------------------------------------------------

interface DenoInfoModule {
  kind: string;
  specifier: string;
  local?: string;
  mediaType?: string;
  dependencies?: Array<{
    specifier: string;
    code?: { specifier: string };
    type?: { specifier: string };
  }>;
}

interface DenoInfoOutput {
  modules: DenoInfoModule[];
  redirects: Record<string, string>;
}

/**
 * Build dependency resolution maps by running `deno info --json`.
 * Works with both Deno's global cache (DENO_DIR) and vendored deps.
 * Also triggers caching of any uncached dependencies.
 */
async function buildResolutionFromDenoInfo(
  projectDir: string,
  files: string[],
): Promise<{
  /** local file path → Map of (raw import specifier → resolved local path) */
  fileResolutions: Map<string, Map<string, string>>;
  /** local cache path → canonical specifier (for pretty-printing) */
  localToSpecifier: Map<string, string>;
}> {
  // Create a temporary entry file that imports all user files so we can
  // resolve the complete dependency graph in a single `deno info` call.
  const tmpFileName = ".deblock_resolve_tmp.ts";
  const tmpPath = path.join(projectDir, tmpFileName);
  const imports = files.map((f) => {
    const rel = f.startsWith("/") ? path.relative(projectDir, f) : f;
    return `import "./${rel}";`;
  }).join("\n");

  await Deno.writeTextFile(tmpPath, imports);

  try {
    const proc = new Deno.Command("deno", {
      args: ["info", "--json", tmpPath],
      cwd: projectDir,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await proc.output();

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      console.error(
        yellow("Warning: failed to resolve dependencies via deno info:"),
        stderr,
      );
      return { fileResolutions: new Map(), localToSpecifier: new Map() };
    }

    const info: DenoInfoOutput = JSON.parse(
      new TextDecoder().decode(output.stdout),
    );

    // specifier → local path
    const specToLocal = new Map<string, string>();
    // local path → specifier (for pretty-printing)
    const localToSpecifier = new Map<string, string>();

    for (const mod of info.modules) {
      if (mod.local) {
        specToLocal.set(mod.specifier, mod.local);
        localToSpecifier.set(mod.local, mod.specifier);
      }
    }

    // redirects: jsr:@scope/pkg@ver/sub → https://jsr.io/…
    const redirectToTarget = new Map<string, string>();
    for (const [from, to] of Object.entries(info.redirects ?? {})) {
      redirectToTarget.set(from, to);
    }

    // Per-file resolution: local path → Map of (raw import → resolved local path)
    const fileResolutions = new Map<string, Map<string, string>>();

    for (const mod of info.modules) {
      if (!mod.local || !mod.dependencies) continue;
      const deps = new Map<string, string>();

      for (const dep of mod.dependencies) {
        const resolvedSpec = dep.code?.specifier ?? dep.type?.specifier;
        if (!resolvedSpec) continue;

        // Direct lookup
        let localPath = specToLocal.get(resolvedSpec);

        // Try via redirect chain
        if (!localPath) {
          const redirected = redirectToTarget.get(resolvedSpec);
          if (redirected) {
            localPath = specToLocal.get(redirected);
          }
        }

        if (localPath) {
          deps.set(dep.specifier, localPath);
        }
      }

      if (deps.size > 0) {
        fileResolutions.set(mod.local, deps);
      }
    }

    return { fileResolutions, localToSpecifier };
  } finally {
    await Deno.remove(tmpPath).catch(() => {});
  }
}

/** Pretty-print a dependency file path as `@scope/pkg/file.ts`. */
function formatDepPath(
  filePath: string,
  localToSpecifier: Map<string, string>,
): string {
  // Try the specifier map (works for both global cache and vendor)
  const specifier = localToSpecifier.get(filePath);
  if (specifier) {
    const m = specifier.match(
      /https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\/[^/]+\/(.*)/,
    );
    if (m) return `${m[1]}/${m[2]}`;
    return specifier;
  }
  // Fallback: vendor path format
  const m = filePath.match(/\/vendor\/jsr\.io\/(@[^/]+\/[^/]+)\/[^/]+\/(.*)/);
  if (m) return `${m[1]}/${m[2]}`;
  return filePath;
}

// ---------------------------------------------------------------------------
// Set up the project
// ---------------------------------------------------------------------------

const projectDir = Deno.cwd();
const files = await getFiles();
if (files.length === 0) {
  console.log(yellow("No files found to check."));
  Deno.exit(0);
}

// Resolve all dependencies via `deno info` (works with global cache or vendor)
let fileResolutions = new Map<string, Map<string, string>>();
let localToSpecifier = new Map<string, string>();

if (!noDeps) {
  console.log(gray("Resolving dependencies…"));
  const resolved = await buildResolutionFromDenoInfo(projectDir, files);
  fileResolutions = resolved.fileResolutions;
  localToSpecifier = resolved.localToSpecifier;
} else {
  console.log(gray("Skipping dependency resolution (--no-deps)."));
}

const project = new Project({
  resolutionHost: (moduleResolutionHost, getCompilerOptions) => ({
    resolveModuleNames: (moduleNames: string[], containingFile: string) => {
      const compilerOptions = getCompilerOptions();

      return moduleNames.map((moduleName) => {
        // 1. Try deno info resolution (handles JSR, import maps, internal deps)
        const fileRes = fileResolutions.get(containingFile);
        if (fileRes) {
          const resolvedPath = fileRes.get(moduleName);
          if (resolvedPath) {
            try {
              Deno.statSync(resolvedPath);
              return {
                resolvedFileName: resolvedPath,
                isExternalLibraryImport: true,
                extension: resolvedPath.endsWith(".js") ? ".js" : ".ts",
              } as ts.ResolvedModuleFull;
            } catch {
              /* file not found – fall through */
            }
          }
        }

        // 2. Fallback – strip .ts extension (Deno convention) and let TS resolve
        const stripped = moduleName.endsWith(".ts")
          ? moduleName.slice(0, -3)
          : moduleName;
        const result = ts.resolveModuleName(
          stripped,
          containingFile,
          compilerOptions,
          moduleResolutionHost,
        );
        return result.resolvedModule;
      });
    },
  }),
});

// Keep track of which files are the user's (not dependencies)
const userFilePaths = new Set<string>(
  files.map((f) => path.resolve(projectDir, f)),
);

console.log(gray(`Analyzing ${files.length} file(s)…`));
for (const file of files) {
  project.addSourceFileAtPath(file);
}

// Pull in dependency source files so the analysis can trace through them
if (!noDeps) {
  const resolvedDeps = project.resolveSourceFileDependencies();
  if (resolvedDeps.length > 0) {
    console.log(
      gray(`Resolved ${resolvedDeps.length} dependency source file(s).`),
    );
  }
}

const allFunctions: (Node & FunctionLikeDeclaration)[] = [];
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

function getFunctionName(func: Node & FunctionLikeDeclaration): string {
  if (Node.isConstructorDeclaration(func)) return "constructor";
  if (Node.isGetAccessorDeclaration(func)) return `get ${func.getName()}`;
  if (Node.isSetAccessorDeclaration(func)) return `set ${func.getName()}`;

  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    return func.getName() ?? "anonymous function";
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

function isAsyncFunction(func: Node & FunctionLikeDeclaration): boolean {
  return Node.isAsyncable(func) && func.isAsync();
}

/** Well-known blocking function names from node: builtins. */
const NODE_SYNC_NAMES = new Set([
  // node:fs
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "closeSync",
  "copyFileSync",
  "cpSync",
  "existsSync",
  "fchmodSync",
  "fchownSync",
  "fdatasyncSync",
  "fstatSync",
  "fsyncSync",
  "ftruncateSync",
  "futimesSync",
  "lchmodSync",
  "lchownSync",
  "linkSync",
  "lstatSync",
  "lutimesSync",
  "mkdirSync",
  "mkdtempSync",
  "opendirSync",
  "openSync",
  "readSync",
  "readdirSync",
  "readFileSync",
  "readlinkSync",
  "realpathSync",
  "renameSync",
  "rmdirSync",
  "rmSync",
  "statSync",
  "statfsSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync",
  "writeSync",
  // node:child_process
  "execSync",
  "execFileSync",
  "spawnSync",
  // node:crypto
  "randomFillSync",
  "scryptSync",
  "pbkdf2Sync",
]);

/**
 * Map of Deno sync API names to their async equivalents.
 * Only covers APIs where the async version has the same signature minus "Sync".
 */
const DENO_SYNC_TO_ASYNC: Record<string, string> = {
  "Deno.readTextFileSync": "Deno.readTextFile",
  "Deno.writeTextFileSync": "Deno.writeTextFile",
  "Deno.readFileSync": "Deno.readFile",
  "Deno.writeFileSync": "Deno.writeFile",
  "Deno.statSync": "Deno.stat",
  "Deno.lstatSync": "Deno.lstat",
  "Deno.mkdirSync": "Deno.mkdir",
  "Deno.removeSync": "Deno.remove",
  "Deno.renameSync": "Deno.rename",
  "Deno.copyFileSync": "Deno.copyFile",
  "Deno.readDirSync": "Deno.readDir",
  "Deno.readLinkSync": "Deno.readLink",
  "Deno.realPathSync": "Deno.realPath",
  "Deno.truncateSync": "Deno.truncate",
  "Deno.symlinkSync": "Deno.symlink",
  "Deno.linkSync": "Deno.link",
  "Deno.chmodSync": "Deno.chmod",
  "Deno.chownSync": "Deno.chown",
  "Deno.openSync": "Deno.open",
  "Deno.createSync": "Deno.create",
  "Deno.makeTempDirSync": "Deno.makeTempDir",
  "Deno.makeTempFileSync": "Deno.makeTempFile",
  "Deno.fstatSync": "Deno.fstat",
  "Deno.ftruncateSync": "Deno.ftruncate",
  "Deno.fuTimeSync": "Deno.fuTime",
  "Deno.uTimeSync": "Deno.uTime",
};

function isNativeSyncBlocker(call: CallExpression): string | null {
  const text = call.getExpression().getText();

  // Deno.*Sync APIs
  if (text.startsWith("Deno.") && text.endsWith("Sync")) {
    return text;
  }

  // Direct calls to known node: sync functions (e.g. readFileSync("x"))
  if (NODE_SYNC_NAMES.has(text)) {
    return text;
  }

  // Qualified calls like fs.readFileSync, child_process.execSync, etc.
  const dotIdx = text.lastIndexOf(".");
  if (dotIdx !== -1) {
    const method = text.slice(dotIdx + 1);
    if (NODE_SYNC_NAMES.has(method)) {
      return text;
    }
  }

  return null;
}

/** Resolve a symbol through import aliases to its original declarations. */
function getOriginalDeclarations(
  symbol: ReturnType<CallExpression["getExpression"]> extends
    { getSymbol(): infer S } ? NonNullable<S> : never,
): Node[] {
  let resolved = symbol;
  // Walk the alias chain (import → re-export → original)
  while (resolved.isAlias()) {
    const aliased = resolved.getAliasedSymbol();
    if (!aliased) break;
    resolved = aliased;
  }
  return resolved.getDeclarations();
}

/**
 * Given a declaration node, return the FunctionLikeDeclaration it represents.
 * Handles both direct function declarations and variable declarations whose
 * initializer is a function expression / arrow function.
 */
function getFunctionFromDecl(
  decl: Node,
): (Node & FunctionLikeDeclaration) | undefined {
  if (Node.isFunctionLikeDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && Node.isFunctionLikeDeclaration(init)) return init;
  }
  return undefined;
}

interface BlockingInfo {
  reason: "native" | "calls_blocking";
  callText: string;
  /** The ultimate native call that causes the block (e.g. "Deno.readFileSync") */
  rootCause: string;
  /** Human-readable source location of the root cause */
  rootSource: string;
}

const blockingFunctions = new Map<
  Node & FunctionLikeDeclaration,
  BlockingInfo
>();

// 1. Initial pass: find functions calling native blockers
for (const func of allFunctions) {
  const calls = func.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const native = isNativeSyncBlocker(call);
    if (native) {
      const sf = func.getSourceFile();
      const lc = sf.getLineAndColumnAtPos(call.getStart());
      blockingFunctions.set(func, {
        reason: "native",
        callText: native,
        rootCause: native,
        rootSource: `${
          formatDepPath(sf.getFilePath(), localToSpecifier)
        }:${lc.line}`,
      });
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
      const declarations = getOriginalDeclarations(symbol);
      for (const decl of declarations) {
        const fn = getFunctionFromDecl(decl);
        if (fn) {
          const calleeBlocking = blockingFunctions.get(fn);
          if (calleeBlocking) {
            blockingFunctions.set(func, {
              reason: "calls_blocking",
              callText: call.getExpression().getText(),
              rootCause: calleeBlocking.rootCause,
              rootSource: calleeBlocking.rootSource,
            });
            changed = true;
            break;
          }
        }
      }
      if (changed) break;
    }
  }
}

// 3. Report issues and collect fixable calls
interface FixableCall {
  call: CallExpression;
  syncName: string;
  asyncName: string;
}

let issueCount = 0;
let fixableCount = 0;
const fixableCalls: FixableCall[] = [];
for (const func of allFunctions) {
  if (!isAsyncFunction(func)) continue;

  // Only report for user files unless --all is set
  const sfPath = func.getSourceFile().getFilePath();
  if (!reportAll && !userFilePaths.has(sfPath)) continue;

  const calls = func.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    // Direct native sync call inside user's own async function
    const native = isNativeSyncBlocker(call);
    if (native) {
      report(func, call, native);
      issueCount++;
      // Deno.*Sync calls in user files are auto-fixable — but only when the
      // call sits directly inside the async function (not nested in an inner
      // sync callback like .map(), .forEach(), addEventListener, etc.)
      if (native.startsWith("Deno.") && userFilePaths.has(sfPath)) {
        const asyncName = DENO_SYNC_TO_ASYNC[native];
        // Walk up to the nearest enclosing function-like node
        const innermost = call.getFirstAncestor((node) =>
          Node.isFunctionLikeDeclaration(node)
        );
        if (asyncName && innermost === func) {
          fixableCount++;
          fixableCalls.push({ call, syncName: native, asyncName });
        }
      }
      continue;
    }

    // Call to a function we identified as blocking (could be in a dep)
    const symbol = call.getExpression().getSymbol();
    if (symbol) {
      const declarations = getOriginalDeclarations(symbol);
      for (const decl of declarations) {
        const fn = getFunctionFromDecl(decl);
        if (fn) {
          const blocker = blockingFunctions.get(fn);
          if (blocker) {
            const callName = call.getExpression().getText();
            const detail = blocker.rootCause !== callName
              ? ` (via ${magenta(blocker.rootCause)} in ${
                gray(blocker.rootSource)
              })`
              : "";
            report(
              func,
              call,
              `${callName} is blocking${detail}`,
            );
            issueCount++;
            break;
          }
        }
      }
    }
  }
}

function report(
  func: Node & FunctionLikeDeclaration,
  call: CallExpression,
  reason: string,
) {
  const sourceFile = func.getSourceFile();
  const lineChar = sourceFile.getLineAndColumnAtPos(call.getStart());
  const funcName = getFunctionName(func);
  const relPath = path.relative(projectDir, sourceFile.getFilePath());

  console.log(
    `${red(bold("ERROR"))} ${
      cyan(`${relPath}:${lineChar.line}:${lineChar.column}`)
    }`,
  );
  console.log(`  In async function: ${yellow(funcName)}`);
  console.log(`  Blocking call:     ${red(call.getText())}`);
  console.log(`  Reason:            ${magenta(reason)}`);
  console.log("");
}

if (issueCount === 0) {
  console.log(green(bold("✔ No blocking calls found in async functions.")));
} else {
  // Apply fixes when --fix is set
  if (fixMode && fixableCalls.length > 0) {
    // Process fixes in reverse order within each file so that earlier offsets
    // stay valid when we modify later parts of the text.
    const byFile = new Map<string, FixableCall[]>();
    for (const fc of fixableCalls) {
      const fp = fc.call.getSourceFile().getFilePath();
      if (!byFile.has(fp)) byFile.set(fp, []);
      byFile.get(fp)!.push(fc);
    }

    let fixedCount = 0;
    for (const [filePath, calls] of byFile) {
      // Sort by start position descending so replacements don't shift offsets
      calls.sort((a, b) => b.call.getStart() - a.call.getStart());

      let source = await Deno.readTextFile(filePath);
      for (const { call, asyncName } of calls) {
        const callStart = call.getStart();
        const callEnd = call.getEnd();
        const originalText = source.slice(callStart, callEnd);

        // Replace the sync method name with async in the expression
        const exprText = call.getExpression().getText();
        const newCallText = originalText.replace(exprText, asyncName);

        // Check if the call is a standalone expression statement — if so, no
        // parens needed and we just prepend `await `.
        const parent = call.getParent();
        const isStatement = parent && Node.isExpressionStatement(parent);
        const replacement = isStatement
          ? `await ${newCallText}`
          : `(await ${newCallText})`;

        source = source.slice(0, callStart) + replacement +
          source.slice(callEnd);
        fixedCount++;
      }
      await Deno.writeTextFile(filePath, source);
    }
    console.log(
      green(bold(`\n✔ Fixed ${fixedCount} issue(s).`)) +
        (issueCount - fixedCount > 0
          ? gray(
            ` ${
              issueCount - fixedCount
            } remaining issue(s) require manual fixes.`,
          )
          : ""),
    );
  } else {
    const fixHint = fixableCount > 0
      ? gray(` (${fixableCount} auto-fixable with --fix)`)
      : "";
    console.log(
      red(
        bold(
          `\n✖ Found ${issueCount} blocking call(s) in async functions.`,
        ),
      ) +
        fixHint,
    );
  }
  Deno.exit(fixMode && fixableCalls.length > 0 ? 0 : 1);
}
