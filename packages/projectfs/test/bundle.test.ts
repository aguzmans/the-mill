import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packProject, unpackProject } from "../src/index";

// Round-trips a project through the pack→(Redis)→unpack path a worker uses to get its code
// without a shared filesystem.
const tmps: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "mill-bundle-")); tmps.push(d); return d; };
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("packProject / unpackProject", () => {
  test("packs project.yaml + nested workflow files, and unpacks byte-identical", () => {
    const src = join(mk(), "billing");
    mkdirSync(join(src, "workflows/invoices/nodes"), { recursive: true });
    writeFileSync(join(src, "project.yaml"), "kind: Project\n");
    writeFileSync(join(src, "workflows/invoices/workflow.yaml"), "kind: Workflow\n");
    writeFileSync(join(src, "workflows/invoices/nodes/load.js"), "export default () => ({ loaded: 2 });\n");

    const bundle = packProject(src);
    expect(Object.keys(bundle).sort()).toEqual([
      "project.yaml",
      "workflows/invoices/nodes/load.js",
      "workflows/invoices/workflow.yaml",
    ]);

    const dest = join(mk(), "billing");
    unpackProject(bundle, dest);
    expect(readFileSync(join(dest, "project.yaml"), "utf8")).toBe("kind: Project\n");
    expect(readFileSync(join(dest, "workflows/invoices/nodes/load.js"), "utf8")).toContain("loaded: 2");
  });

  test("excludes node_modules and .git", () => {
    const src = join(mk(), "p");
    mkdirSync(join(src, "node_modules/x"), { recursive: true });
    mkdirSync(join(src, ".git"), { recursive: true });
    writeFileSync(join(src, "project.yaml"), "kind: Project\n");
    writeFileSync(join(src, "node_modules/x/index.js"), "junk");
    writeFileSync(join(src, ".git/config"), "junk");
    expect(Object.keys(packProject(src))).toEqual(["project.yaml"]);
  });

  test("rejects path traversal in a bundle", () => {
    expect(() => unpackProject({ "../escape.js": "x" }, join(mk(), "p"))).toThrow(/illegal bundle path/);
  });
});
