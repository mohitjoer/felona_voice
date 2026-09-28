/**
 * Verifies every relative link and heading anchor in the documentation resolves.
 *
 * A dead link and a stale badge are the same class of problem: a claim the
 * repository does not support. Four broken anchors and one link to a guide that
 * was never written survived in this repo for a while, so the check is
 * automated rather than remembered.
 *
 * Anchor rules follow GitHub: lowercase, strip punctuation except `-` and `_`,
 * then spaces become hyphens. A removed character can leave two adjacent
 * spaces, which is how "A & B" becomes "a--b".
 *
 * Usage: node scripts/check-docs.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** GitHub's heading slug. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/["'`[\]()!,.:;?*#$%&+~=<>{}|/\\]/g, "")
    .replace(/\s/g, "-");
}

/** Collects every heading anchor in a document. */
function anchorsOf(text) {
  const found = new Set();
  let inFence = false;
  for (const line of text.split("\n")) {
    // Headings inside a fenced code block are not headings.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    const anchor = slug(match[2]);
    // First occurrence wins, matching GitHub's behaviour for duplicates.
    if (!found.has(anchor)) found.add(anchor);
  }
  return found;
}

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

const docs = [
  ...markdownFiles(join(root, "docs")),
  join(root, "README.md"),
  join(root, "CONTRIBUTING.md"),
  join(root, "CHANGELOG.md"),
].filter((f) => existsSync(f));

const anchorsByFile = new Map(
  docs.map((file) => [file, anchorsOf(readFileSync(file, "utf8"))]),
);

const brokenLinks = [];
const brokenAnchors = [];

for (const file of docs) {
  const text = readFileSync(file, "utf8");
  // Matches [label](target) while skipping images and bare URLs.
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const target = match[2];
    if (/^(https?:|mailto:|#$)/.test(target)) continue;
    const [path, ...rest] = target.split("#");
    // Fragments may be percent-encoded (an emoji in a heading is written
    // %EF%B8%8F); decode so the comparison is against the real heading.
    const fragment = rest.join("#") ? decodeURIComponent(rest.join("#")) : "";

    if (path.startsWith(".")) {
      const targetPath = resolve(dirname(file), path);
      if (!existsSync(targetPath)) {
        brokenLinks.push(`${file.replace(root + "/", "")} -> ${target}`);
        continue;
      }
      if (fragment) {
        const anchors = anchorsByFile.get(targetPath);
        if (anchors && !anchors.has(fragment)) {
          brokenAnchors.push(
            `${file.replace(root + "/", "")} -> ${target} (no heading "${fragment}")`,
          );
        }
      }
    } else if (fragment) {
      // Same-document anchor.
      const anchors = anchorsByFile.get(file);
      if (anchors && !anchors.has(fragment)) {
        brokenAnchors.push(
          `${file.replace(root + "/", "")} -> ${target} (no heading "${fragment}")`,
        );
      }
    }
  }
}

if (brokenLinks.length || brokenAnchors.length) {
  for (const l of brokenLinks) console.error(`broken link:   ${l}`);
  for (const a of brokenAnchors) console.error(`broken anchor: ${a}`);
  console.error(
    `\n${brokenLinks.length} broken link(s), ${brokenAnchors.length} broken anchor(s).`,
  );
  process.exit(1);
}

console.log(`docs: ${docs.length} files checked, all links and anchors resolve.`);
