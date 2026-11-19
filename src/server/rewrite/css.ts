import { rewriteReference } from '../../shared/url.js';

export interface CssRewriteOptions {
  token: string;
  documentUrl: URL;
  contentOrigin: string;
}

function shouldRewrite(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  if (/^(data|blob|about|javascript):/i.test(trimmed)) return false;
  return true;
}

/**
 * Rewrite absolute and root-relative `url()` and `@import` references so that
 * they load through the proxy. Relative references are left untouched because
 * the stylesheet itself is served from a mirrored proxy path, so they already
 * resolve correctly.
 */
export function rewriteCss(css: string, options: CssRewriteOptions): string {
  const { token, documentUrl, contentOrigin } = options;
  let output = '';
  let index = 0;

  const readString = (quote: string): string => {
    let result = quote;
    index++;
    while (index < css.length) {
      const char = css[index]!;
      result += char;
      if (char === '\\') {
        index++;
        if (index < css.length) result += css[index]!;
      } else if (char === quote) {
        index++;
        return result;
      }
      index++;
    }
    return result;
  };

  const readUrlArgument = (): { raw: string; text: string } => {
    // index points just after "url("
    while (index < css.length && /\s/.test(css[index]!)) index++;
    let quote: string | null = null;
    if (css[index] === '"' || css[index] === "'") quote = css[index]!;
    let raw = '';
    if (quote) {
      index++;
      while (index < css.length) {
        const char = css[index]!;
        if (char === '\\') {
          raw += char;
          index++;
          if (index < css.length) raw += css[index]!;
          index++;
          continue;
        }
        if (char === quote) {
          index++;
          break;
        }
        raw += char;
        index++;
      }
      while (index < css.length && /\s/.test(css[index]!)) index++;
      if (css[index] === ')') index++;
      return { raw, text: `${quote}${raw}${quote}` };
    }
    while (index < css.length && css[index] !== ')') {
      raw += css[index];
      index++;
    }
    if (css[index] === ')') index++;
    return { raw: raw.trim(), text: raw.trim() };
  };

  while (index < css.length) {
    const char = css[index]!;

    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      if (end === -1) {
        output += css.slice(index);
        break;
      }
      output += css.slice(index, end + 2);
      index = end + 2;
      continue;
    }

    if (char === '"' || char === "'") {
      output += readString(char);
      continue;
    }

    if (char === '@' && /^@import\b/i.test(css.slice(index, index + 8))) {
      const match = /^@import\s*/i.exec(css.slice(index))!;
      output += match[0];
      index += match[0].length;
      const next = css[index];
      if (next === '"' || next === "'") {
        const quoted = readString(next);
        const value = quoted.slice(1, -1);
        output += shouldRewrite(value)
          ? `${next}${rewriteReference(value, documentUrl, token, contentOrigin)}${next}`
          : quoted;
      } else if (/^url\(/i.test(css.slice(index, index + 4))) {
        index += 4;
        const argument = readUrlArgument();
        const rewritten = shouldRewrite(argument.raw)
          ? rewriteReference(argument.raw, documentUrl, token, contentOrigin)
          : argument.raw;
        output += `url(${JSON.stringify(rewritten)})`;
      }
      continue;
    }

    if ((char === 'u' || char === 'U') && /^url\(/i.test(css.slice(index, index + 4))) {
      // Ensure this is a function token, not part of an identifier.
      const previous = index === 0 ? '' : css[index - 1]!;
      if (previous && /[\w-]/.test(previous)) {
        output += char;
        index++;
        continue;
      }
      index += 4;
      const argument = readUrlArgument();
      if (argument.raw && shouldRewrite(argument.raw)) {
        const rewritten = rewriteReference(argument.raw, documentUrl, token, contentOrigin);
        // Keep the original spelling when nothing changes (relative URLs are
        // resolved by the stylesheet's own proxied location).
        output += rewritten === argument.raw ? `url(${argument.text})` : `url(${JSON.stringify(rewritten)})`;
      } else {
        output += `url(${argument.text})`;
      }
      continue;
    }

    output += char;
    index++;
  }

  return output;
}

/** Rewrite url() references inside a style="" attribute. */
export function rewriteStyleAttribute(
  style: string,
  options: CssRewriteOptions,
): string {
  if (!/url\(/i.test(style)) return style;
  return rewriteCss(style, options);
}
