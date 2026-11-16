/**
 * Canonical href for an http(s) URL without embedded credentials, or null. The WHATWG
 * serialization percent-encodes whitespace and `<`/`>`, so the result is safe inside a
 * Markdown `<...>` link destination.
 */
export function normalizeHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const allowed =
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.host) &&
      !parsed.username &&
      !parsed.password;
    return allowed ? parsed.href : null;
  } catch {
    return null;
  }
}

export function httpUrl(rawUrl: string): boolean {
  return normalizeHttpUrl(rawUrl) !== null;
}
