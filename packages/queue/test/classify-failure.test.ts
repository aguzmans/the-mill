import { test, expect, describe } from "bun:test";
import { classifyFailure } from "../src/index";

describe("classifyFailure — job failure reason buckets", () => {
  test("the worker-can't-see-workdir error → workflow_not_found", () => {
    // This is the exact string a worker with no /app/workdir mount produces.
    expect(classifyFailure("file not found: /app/workdir/ops-acuity-flows/workflows/x/workflow.yaml")).toBe("workflow_not_found");
    expect(classifyFailure("ENOENT: no such file or directory")).toBe("workflow_not_found");
  });
  test("compile/build errors → compile_error", () => {
    expect(classifyFailure("workflow 'x' won't compile: SyntaxError")).toBe("compile_error");
    expect(classifyFailure("check: BuildMessage: Syntax Error")).toBe("compile_error");
  });
  test("schema / timeout / network buckets", () => {
    expect(classifyFailure("input failed schema validation")).toBe("schema_validation");
    expect(classifyFailure("node timed out after 60s")).toBe("timeout");
    expect(classifyFailure("fetch failed: ECONNREFUSED")).toBe("network");
  });
  test("empty → unknown, anything else → node_error", () => {
    expect(classifyFailure("")).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
    expect(classifyFailure("TypeError: cannot read properties of undefined")).toBe("node_error");
  });
});
