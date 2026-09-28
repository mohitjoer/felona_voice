/**
 * Verifies the README test-count badge matches the real test count.
 *
 * The badge sat at "62 passed" while the suite ran 423, then at 542 while it
 * ran 587. A badge is a claim; a wrong one is worse than none, because it is
 * the kind of thing nobody checks precisely because it is always roughly
 * right.
 *
 * Usage: node scripts/check-badge.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readme = readFileSync(join(root, "README.md"), "utf8");
const badge = /badge\/tests-(\d+)%20passed/.exec(readme);

if (!badge) {
  console.error("README has no tests-<n> passed badge to verify.");
  process.exit(1);
}

const claimed = Number(badge[1]);

/** Every test file under packages/, skipping build output and node_modules. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Count `it(` and `test(` at the start of a line inside test files, which is
// how this repo writes them. `describe` blocks are not tests.
let actual = 0;
for (const file of walk(join(root, "packages"))) {
  if (!/\.test\.tsx?$/.test(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(it|test)\s*\(/.test(line)) actual++;
  }
}

if (claimed !== actual) {
  console.error(
    `README badge claims ${claimed} tests, the suite contains ${actual}.\n` +
      `Update the badge in README.md to tests-${actual}%20passed.`,
  );
  process.exit(1);
}

console.log(`badge: ${claimed} tests claimed, ${actual} found.`);
