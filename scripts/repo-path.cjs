// Repository-contained path resolution for Node/CJS/tsx artifact writers.
// Resolve the deepest existing ancestor through realpath before appending any
// not-yet-created suffix, so an existing symlink/junction parent cannot escape.
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = fs.realpathSync.native(path.resolve(__dirname, ".."));

function deepestResolvedPath(candidate) {
  let cursor = path.resolve(candidate);
  const missing = [];
  for (;;) {
    let entryExists = false;
    try {
      fs.lstatSync(cursor);
      entryExists = true;
    } catch (error) {
      if (error && error.code !== "ENOENT") throw error;
    }
    if (entryExists) {
      // lstat detects a broken symlink too. Keep realpath outside the ENOENT
      // handler so a broken existing link fails closed rather than becoming a
      // supposedly safe not-yet-created path segment.
      const ancestor = fs.realpathSync.native(cursor);
      return path.resolve(ancestor, ...missing);
    }
    {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("path has no resolvable existing ancestor");
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function resolveRepoContainedPath(value, label = "path", options = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty path inside this repository`);
  }
  const candidate = path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
  const resolved = deepestResolvedPath(candidate);
  const relative = path.relative(REPO_ROOT, resolved);
  const inside = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  if (!inside) throw new Error(`${label} must resolve inside this repository`);
  if (options.mustExist && !fs.existsSync(resolved)) {
    throw new Error(`${label} must name an existing path inside this repository`);
  }
  return resolved;
}

module.exports = { REPO_ROOT, resolveRepoContainedPath };

if (require.main === module) {
  const args = process.argv.slice(2);
  const labelIndex = args.indexOf("--label");
  const label = labelIndex >= 0 ? args[labelIndex + 1] : "path";
  const mustExist = args.includes("--must-exist");
  const positional = args.filter((arg, index) =>
    arg !== "--must-exist" && arg !== "--label" && index !== labelIndex + 1
  );
  try {
    if (!positional[0]) throw new Error("path is required");
    process.stdout.write(resolveRepoContainedPath(positional[0], label, { mustExist }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "path validation failed"}\n`);
    process.exitCode = 1;
  }
}
