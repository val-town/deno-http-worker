import type { UndiciHeaders } from "undici/types/dispatcher.js";
import { describe, expect, it } from "vitest";
import { undiciHeadersAsRecord } from "./utils.js";

describe("undiciHeadersAsRecord", () => {
  it("should convert an array of headers to a lowercase object", () => {
    const headers: UndiciHeaders = [
      ["Content-Type", "application/json"],
      ["Authorization", "Bearer token"],
    ];
    const result = undiciHeadersAsRecord(headers);
    expect(result).toEqual({
      "content-type": "application/json",
      authorization: "Bearer token",
    });
  });

  it("should handle multiple values for the same header", () => {
    const headers: UndiciHeaders = [
      ["Set-Cookie", "cookie1=value1"],
      ["Set-Cookie", "cookie2=value2"],
    ];
    const result = undiciHeadersAsRecord(headers);
    expect(result).toEqual({
      "set-cookie": "cookie1=value1, cookie2=value2",
    });
  });

  it("should convert an object of headers to a lowercase object", () => {
    const headers: UndiciHeaders = {
      "Content-Type": "application/json",
      Authorization: "Bearer token",
    };
    const result = undiciHeadersAsRecord(headers);
    expect(result).toEqual({
      "content-type": "application/json",
      authorization: "Bearer token",
    });
  });

  it("should convert headers that have iterable values", () => {
    const headers: UndiciHeaders = {
      Accept: ["application/json", "text/plain"],
      "Cache-Control": "no-cache",
    };
    const result = undiciHeadersAsRecord(headers);
    expect(result).toEqual({
      accept: "application/json, text/plain",
      "cache-control": "no-cache",
    });
  });
});
