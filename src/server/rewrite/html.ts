import { parse, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { proxifyUrl, rewriteReference, type ProxyMode } from '../../shared/url.js';
import type { RuntimeBootstrap } from '../../shared/runtime.js';
import { rewriteCss, rewriteStyleAttribute } from './css.js';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

export interface HtmlRewriteOptions {
  token: string;
  /** Absolute URL of the document being rewritten. */
  documentUrl: URL;
  contentOrigin: string;
  parentOrigin: string;
  mode: ProxyMode;
  runtimeUrl: string;
  cookieSnapshot: string;
  enableServerStorage: boolean;
  documentHandle: string;
}

/** Attributes that contain a single URL and must be proxied. */
const URL_ATTRIBUTES: Record<string, string[]> = {
  a: ['href'],
  area: ['href'],
  link: ['href', 'imagesrcset'],
  img: ['src', 'srcset', 'longdesc'],
  script: ['src'],
  iframe: ['src'],
  frame: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  source: ['src', 'srcset'],
  track: ['src'],
  embed: ['src'],
  object: ['data'],
  input: ['src', 'formaction'],
  button: ['formaction'],
  form: ['action'],
  blockquote: ['cite'],
  q: ['cite'],
  ins: ['cite'],
  del: ['cite'],
  body: ['background'],
  table: ['background'],
  td: ['background'],
  th: ['background'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
  meta: [],
};

const DROPPED_ON_SIGHT = new Set(['base']);

function isElement(node: Node): node is Element {
  return typeof (node as Element).tagName === 'string';
}

function getAttribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function setAttribute(element: Element, name: string, value: string): void {
  const existing = element.attrs.find((attribute) => attribute.name === name);
  if (existing) existing.value = value;
  else element.attrs.push({ name, value });
}

function removeAttribute(element: Element, name: string): void {
  element.attrs = element.attrs.filter((attribute) => attribute.name !== name);
}

function childNodesOf(node: Node): ChildNode[] {
  if ('content' in node) {
    const content = (node as unknown as DefaultTreeAdapterTypes.Template).content;
    if (content) return (content.childNodes ?? []) as ChildNode[];
  }
  if ('childNodes' in node) return (node as ParentNode).childNodes as ChildNode[];
  return [];
}

/** Iterate elements depth-first, including <template> contents. */
function walk(node: Node, visit: (element: Element) => void): void {
  for (const child of childNodesOf(node)) {
    if (isElement(child)) {
      visit(child);
      walk(child, visit);
    } else if ('content' in child) {
      walk(child, visit);
    } else {
      walk(child, visit);
    }
  }
}

function rewriteSrcset(
  value: string,
  documentUrl: URL,
  token: string,
  contentOrigin: string,
): string {
  // Srcset is a comma-separated list of "url descriptor" pairs. Data URLs may
  // contain commas, so parse tuples instead of naively splitting on commas.
  let index = 0;
  const parts: string[] = [];
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index]!)) index++;
    if (index >= value.length) break;
    const urlStart = index;
    while (index < value.length && !/\s/.test(value[index]!)) index++;
    const url = value.slice(urlStart, index);
    const descriptorStart = index;
    while (index < value.length && value[index] !== ',') index++;
    const descriptor = value.slice(descriptorStart, index).trim();
    if (index < value.length) index++; // consume comma
    if (!url) continue;
    const rewritten = /^(data|blob):/i.test(url)
      ? url
      : rewriteReference(url, documentUrl, token, contentOrigin);
    parts.push(descriptor ? `${rewritten} ${descriptor}` : rewritten);
  }
  return parts.join(', ');
}

function findHead(document: Node): Element | null {
  for (const child of (document as ParentNode).childNodes as Node[]) {
    if (isElement(child) && child.tagName === 'html') {
      for (const inner of child.childNodes as Node[]) {
        if (isElement(inner) && inner.tagName === 'head') return inner;
      }
    }
  }
  return null;
}

function rewriteMetaRefresh(
  content: string,
  documentUrl: URL,
  token: string,
  contentOrigin: string,
): string {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/i.exec(content);
  if (!match) return content;
  const delay = match[1]!;
  let target = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!target) return content;
  target = rewriteReference(target, documentUrl, token, contentOrigin);
  return `${delay}; url=${target}`;
}

/**
 * Rewrite an HTML document so every reference loads through the proxy.
 *
 * A `<base>` element pointing at the proxied document URL is injected. That
 * single element makes every *relative* URL in the document (including URLs
 * created later by JavaScript) resolve through the proxy, which is the main
 * reason runtime-generated content keeps working.
 */
export function rewriteHtml(html: string, options: HtmlRewriteOptions): string {
  const { token, contentOrigin, documentUrl } = options;
  const document = parse(html);

  let baseUrl = documentUrl;
  const removals = new Set<Element>();

  walk(document as unknown as Node, (element) => {
    const tag = element.tagName;
    if (tag === 'base') {
      const href = getAttribute(element, 'href');
      if (href) {
        try {
          baseUrl = new URL(href, documentUrl);
        } catch {
          /* ignore invalid base */
        }
      }
    }
  });

  walk(document as unknown as Node, (element) => {
    const tag = element.tagName;

    // Remove elements/attributes that would fight the proxy or leak requests.
    if (DROPPED_ON_SIGHT.has(tag)) {
      removals.add(element);
      return;
    }

    removeAttribute(element, 'integrity');
    removeAttribute(element, 'nonce');
    removeAttribute(element, 'crossorigin');
    removeAttribute(element, 'ping');
    if (tag === 'html') removeAttribute(element, 'manifest');

    if (tag === 'link') {
      const rel = (getAttribute(element, 'rel') ?? '').toLowerCase();
      if (rel.includes('preconnect') || rel.includes('dns-prefetch') || rel === 'prefetch') {
        removals.add(element);
        return;
      }
    }

    if (tag === 'meta') {
      const httpEquiv = (getAttribute(element, 'http-equiv') ?? '').toLowerCase();
      if (httpEquiv === 'content-security-policy' || httpEquiv === 'content-security-policy-report-only') {
        removals.add(element);
        return;
      }
      if (httpEquiv === 'refresh') {
        const content = getAttribute(element, 'content');
        if (content) {
          setAttribute(element, 'content', rewriteMetaRefresh(content, documentUrl, token, contentOrigin));
        }
      }
      const charset = getAttribute(element, 'charset');
      if (charset) {
        removals.add(element);
        return;
      }
    }

    const style = getAttribute(element, 'style');
    if (style && style.includes('url(')) {
      setAttribute(element, 'style', rewriteStyleAttribute(style, { token, documentUrl, contentOrigin }));
    }

    if (tag === 'style') {
      for (const child of element.childNodes) {
        if (child.nodeName === '#text') {
          const textNode = child as DefaultTreeAdapterTypes.TextNode;
          textNode.value = rewriteCss(textNode.value, { token, documentUrl, contentOrigin });
        }
      }
    }

    const urlAttributes = URL_ATTRIBUTES[tag];
    if (!urlAttributes) return;
    for (const attributeName of urlAttributes) {
      const value = getAttribute(element, attributeName);
      if (value === undefined) continue;
      if (attributeName === 'srcset' || attributeName === 'imagesrcset') {
        setAttribute(element, attributeName, rewriteSrcset(value, documentUrl, token, contentOrigin));
      } else if (attributeName === 'href' && tag === 'link') {
        const rel = (getAttribute(element, 'rel') ?? '').toLowerCase();
        if (rel === 'canonical' || rel === 'amphtml') {
          // Keep these pointing at the real site so "share" and readers do not
          // advertise a session-scoped URL.
          continue;
        }
        setAttribute(element, attributeName, rewriteReference(value, documentUrl, token, contentOrigin));
      } else {
        setAttribute(element, attributeName, rewriteReference(value, documentUrl, token, contentOrigin));
      }
    }

  });

  // Remove nodes collected above (base, CSP/charset metas, preconnect hints).
  if (removals.size > 0) {
    const strip = (parent: ParentNode): void => {
      const filtered = (parent.childNodes as Node[]).filter(
        (node) => !(isElement(node) && removals.has(node)),
      ) as ChildNode[];
      (parent as { childNodes: ChildNode[] }).childNodes = filtered;
      for (const node of parent.childNodes as Node[]) {
        if (isElement(node) || 'content' in node) strip(node as unknown as ParentNode);
      }
    };
    strip(document as unknown as ParentNode);
  }

  const head = findHead(document);
  if (head) {
    const bootstrap: RuntimeBootstrap = {
      token,
      target: documentUrl.href,
      contentOrigin,
      parentOrigin: options.parentOrigin,
      mode: options.mode,
      cookie: options.cookieSnapshot,
      handle: options.documentHandle,
      storage: options.enableServerStorage,
    };
    const configJson = JSON.stringify(bootstrap)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');
    const injection = parseFragment(
      `<meta charset="utf-8">` +
        `<base href="${proxifyUrl(token, baseUrl, contentOrigin)}">` +
        `<script id="__oa-bootstrap" type="application/json">${configJson}</script>` +
        `<script src="${options.runtimeUrl}"></script>`,
    );
    (head.childNodes as Node[]).unshift(...(injection.childNodes as Node[]));
  }

  return serialize(document, {});
}
