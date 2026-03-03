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
  boolean: ["help"],
  string: ["exclude"],
  collect: ["exclude"],
  alias: { h: "help", e: "exclude" },
  default: { help: false, exclude: [] },
});

if (parsed.help) {
  console.log(`
${bold("Usage:")} deno run -A check-blocking.ts [options] [<files...>]

Looks for blocking Deno APIs inside asynchronous functions.

${bold("Options:")}
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

// ---------------------------------------------------------------------------
// Vendor / JSR resolution
// ---------------------------------------------------------------------------

interface JsrPackageInfo {
  /** Absolute path to the versioned directory */
  versionDir: string;
  /** Resolved version string, e.g. "1.1.4" */
  version: string;
  /** Exports map from <version>_meta.json, e.g. { "./join": "./join.ts" } */
  exports: Record<string, string>;
}

/** Scan vendor/jsr.io and build an index of every vendored JSR package. */
async function buildVendorIndex(
  vendorDir: string,
): Promise<Map<string, JsrPackageInfo>> {
  const index = new Map<string, JsrPackageInfo>();
  const jsrDir = path.join(vendorDir, "jsr.io");

  try {
    for await (const scopeEntry of Deno.readDir(jsrDir)) {
      if (!scopeEntry.isDirectory || !scopeEntry.name.startsWith("@")) continue;
      const scopeDir = path.join(jsrDir, scopeEntry.name);

      for await (const pkgEntry of Deno.readDir(scopeDir)) {
        if (!pkgEntry.isDirectory) continue;
        const pkgDir = path.join(scopeDir, pkgEntry.name);
        const pkgName = `${scopeEntry.name}/${pkgEntry.name}`;

        for await (const entry of Deno.readDir(pkgDir)) {
          if (!entry.isDirectory) continue;
          const version = entry.name;
          const versionDir = path.join(pkgDir, version);
          const metaPath = path.join(pkgDir, `${version}_meta.json`);

          try {
            const meta = JSON.parse(await Deno.readTextFile(metaPath));
            index.set(pkgName, {
              versionDir,
              version,
              exports: meta.exports ?? {},
            });
          } catch {
            index.set(pkgName, { versionDir, version, exports: {} });
          }
        }
      }
    }
  } catch {
    // vendor directory missing or unreadable – not an error
  }

  return index;
}

/** Read the import map from deno.json. */
async function loadImportMap(
  projectDir: string,
): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(
      await Deno.readTextFile(path.join(projectDir, "deno.json")),
    );
    return raw.imports ?? {};
  } catch {
    return {};
  }
}

/** Parse `jsr:@scope/name@version/subpath` into its parts. */
function parseJsrSpecifier(
  specifier: string,
): { pkgName: string; subpath: string } | null {
  const m = specifier.match(/^jsr:(@[^/]+\/[^@]+)@[^/]*(\/.*)?$/);
  if (!m) return null;
  return { pkgName: m[1], subpath: m[2] ?? "" };
}

/** Resolve a `jsr:` specifier to an absolute file path inside the vendor tree. */
function resolveJsrToVendor(
  specifier: string,
  vendorIndex: Map<string, JsrPackageInfo>,
): string | null {
  const parsed = parseJsrSpecifier(specifier);
  if (!parsed) return null;

  const pkg = vendorIndex.get(parsed.pkgName);
  if (!pkg) return null;

  const exportKey = parsed.subpath ? `.${parsed.subpath}` : ".";
  let resolved = pkg.exports[exportKey];

  if (!resolved && parsed.subpath) {
    // Fallback: direct file mapping (subpath → subpath.ts)
    resolved = `.${parsed.subpath}.ts`;
  }
  if (!resolved) {
    resolved = pkg.exports["."] ?? "./mod.ts";
  }

  return path.resolve(pkg.versionDir, resolved);
}

/**
 * Main entry point for custom module resolution.
 * Handles bare specifiers via the deno.json import map and `jsr:` specifiers.
 */
function resolveModuleSpecifier(
  moduleName: string,
  importMap: Record<string, string>,
  vendorIndex: Map<string, JsrPackageInfo>,
): string | null {
  // Already a jsr: specifier (used by vendored deps internally)
  if (moduleName.startsWith("jsr:")) {
    return resolveJsrToVendor(moduleName, vendorIndex);
  }

  // Try the deno.json import map
  for (const [key, value] of Object.entries(importMap)) {
    if (moduleName === key || moduleName.startsWith(key + "/")) {
      const suffix = moduleName === key ? "" : moduleName.slice(key.length);
      if (value.startsWith("jsr:")) {
        return resolveJsrToVendor(value + suffix, vendorIndex);
      }
    }
  }

  return null;
}

/** Pretty-print a vendor file path as `@scope/pkg/file.ts`. */
function formatDepPath(filePath: string): string {
  const m = filePath.match(/\/vendor\/jsr\.io\/(@[^/]+\/[^/]+)\/[^/]+\/(.*)/);
  if (m) return `${m[1]}/${m[2]}`;
  return filePath;
}

// ---------------------------------------------------------------------------
// Set up the project with vendor-aware resolution
// ---------------------------------------------------------------------------

const projectDir = Deno.cwd();
const vendorDir = path.join(projectDir, "vendor");

const [vendorIndex, importMap] = await Promise.all([
  buildVendorIndex(vendorDir),
  loadImportMap(projectDir),
]);

const project = new Project({
  resolutionHost: (moduleResolutionHost, getCompilerOptions) => ({
    resolveModuleNames: (moduleNames: string[], containingFile: string) => {
      const compilerOptions = getCompilerOptions();

      return moduleNames.map((moduleName) => {
        // 1. Try vendor / import-map resolution
        const vendorPath = resolveModuleSpecifier(
          moduleName,
          importMap,
          vendorIndex,
        );
        if (vendorPath) {
          try {
            Deno.statSync(vendorPath); // verify it exists
            return {
              resolvedFileName: vendorPath,
              isExternalLibraryImport: true,
              extension: vendorPath.endsWith(".js") ? ".js" : ".ts",
            } as ts.ResolvedModuleFull;
          } catch {
            /* file not found – fall through to default resolution */
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

const files = await getFiles();
if (files.length === 0) {
  console.log(yellow("No files found to check."));
  Deno.exit(0);
}

// Keep track of which files are the user's (not dependencies)
const userFilePaths = new Set<string>(
  files.map((f) => path.resolve(projectDir, f)),
);

console.log(gray(`Analyzing ${files.length} file(s)…`));
for (const file of files) {
  project.addSourceFileAtPath(file);
}

// Pull in dependency source files so the analysis can trace through them
const resolvedDeps = project.resolveSourceFileDependencies();
if (resolvedDeps.length > 0) {
  console.log(
    gray(`Resolved ${resolvedDeps.length} dependency source file(s).`),
  );
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
        rootSource: `${formatDepPath(sf.getFilePath())}:${lc.line}`,
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
        if (Node.isFunctionLikeDeclaration(decl)) {
          const calleeBlocking = blockingFunctions.get(decl);
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

// 3. Report issues – only in user source files
let foundIssues = false;
for (const func of allFunctions) {
  if (!isAsyncFunction(func)) continue;

  // Only report for user files, not dependencies
  const sfPath = func.getSourceFile().getFilePath();
  if (!userFilePaths.has(sfPath)) continue;

  const calls = func.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    // Direct native sync call inside user's own async function
    const native = isNativeSyncBlocker(call);
    if (native) {
      report(func, call, native);
      foundIssues = true;
      continue;
    }

    // Call to a function we identified as blocking (could be in a dep)
    const symbol = call.getExpression().getSymbol();
    if (symbol) {
      const declarations = getOriginalDeclarations(symbol);
      for (const decl of declarations) {
        if (Node.isFunctionLikeDeclaration(decl)) {
          const blocker = blockingFunctions.get(decl);
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
            foundIssues = true;
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

if (!foundIssues) {
  console.log(green(bold("✔ No blocking calls found in async functions.")));
} else {
  console.log(red(bold("\n✖ Found blocking calls in async functions.")));
  Deno.exit(1);
}
