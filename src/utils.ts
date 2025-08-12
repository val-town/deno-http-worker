import type { UndiciHeaders } from "undici/types/dispatcher.js";

/**
 * Converts UndiciHeaders to a Record with lowercase keys.
 *
 * @param headers An UndiciHeaders type -- usually an array of tuples or an object.
 * @returns A record with lowercase keys and string values.
 */
export function undiciHeadersAsRecord(
  headers: UndiciHeaders
): Record<string, string> {
  const result: Record<string, string> = {};

  if (!headers) return result;

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key) {
        const existing = result[key.toLowerCase()];
        if (existing) {
          result[key.toLowerCase()] = `${existing}, ${value}`;
        } else {
          result[key.toLowerCase()] = value ?? "";
        }
      }
    }
  } else if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key) {
        if (Array.isArray(value)) {
          result[key.toLowerCase()] = value.join(", ");
        } else {
          result[key.toLowerCase()] = value ?? "";
        }
      }
    }
  }

  return result;
}
