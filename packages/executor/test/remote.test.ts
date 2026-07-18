import { test, expect, describe, afterEach } from "bun:test";
import { isRemoteRef, resolveRemoteUrl } from "../src";

describe("remote callScript refs", () => {
  const orig = process.env.MILL_STD_REGISTRY;
  afterEach(() => { if (orig === undefined) delete process.env.MILL_STD_REGISTRY; else process.env.MILL_STD_REGISTRY = orig; });

  test("recognizes remote vs in-project refs", () => {
    expect(isRemoteRef("std://acme/notify@v2")).toBe(true);
    expect(isRemoteRef("https://example.com/b.tgz")).toBe(true);
    expect(isRemoteRef("http://api:8080/api/projects/x/export")).toBe(true);
    expect(isRemoteRef("workflows/notify")).toBe(false);
    expect(isRemoteRef("notify")).toBe(false);
  });

  test("http(s) refs pass through unchanged", () => {
    expect(resolveRemoteUrl("https://example.com/b.tgz")).toBe("https://example.com/b.tgz");
  });

  test("std:// resolves against MILL_STD_REGISTRY", () => {
    process.env.MILL_STD_REGISTRY = "https://registry.example.com/";
    expect(resolveRemoteUrl("std://acme/notify@v2")).toBe("https://registry.example.com/acme/notify@v2.tgz");
  });

  test("std:// without a registry configured throws", () => {
    delete process.env.MILL_STD_REGISTRY;
    expect(() => resolveRemoteUrl("std://acme/notify@v2")).toThrow(/MILL_STD_REGISTRY/);
  });
});
