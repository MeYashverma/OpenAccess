import { describe, expect, it } from 'vitest';
import { rewriteHtml } from '../src/server/rewrite/html.js';
import { rewriteCss } from '../src/server/rewrite/css.js';

const TOKEN = 'T'.repeat(32);
const doc = new URL('https://site.example/dir/page.html');
const options = {
  token: TOKEN,
  documentUrl: doc,
  contentOrigin: 'https://p.openaccess.example',
  parentOrigin: 'https://openaccess.example',
  mode: 'isolated' as const,
  runtimeUrl: 'https://p.openaccess.example/__oa/runtime.js',
  cookieSnapshot: 'a=1',
  enableServerStorage: true,
  documentHandle: 'signed-handle',
};
const proxy = (scheme: string, host: string, path: string) =>
  `https://p.openaccess.example/p/${TOKEN}/${scheme}/${host}${path}`;

describe('HTML rewriting', () => {
  const html = `<!doctype html><html><head>
<meta charset="iso-8859-1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<base href="/assets/">
<link rel="stylesheet" href="/style.css" integrity="sha384-abc" nonce="n">
<link rel="preconnect" href="https://fonts.example">
<link rel="canonical" href="https://site.example/dir/page.html">
<style>.a{background:url(/bg.png)}</style>
</head><body style="background:url('/body.png')">
<a href="/next">next</a>
<a href="rel.html">rel</a>
<a href="mailto:x@y.z">mail</a>
<img src="img.png" srcset="/one.png 1x, two.png 2x, data:image/png;base64,AA,BB 3x" crossorigin="anonymous" integrity="sha256-x">
<iframe src="/frame" srcdoc="<p>inline</p>"></iframe>
<form action="/submit" method="post"></form>
<meta http-equiv="refresh" content="5; url=/elsewhere">
<script src="/app.js"></script>
</body></html>`;

  const out = rewriteHtml(html, options);

  it('injects the base, bootstrap, runtime and a utf-8 charset', () => {
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain(
      `<base href="https://p.openaccess.example/p/${TOKEN}/https/site.example/assets/">`,
    );
    expect(out).toContain('id="__oa-bootstrap"');
    expect(out).toContain('https://p.openaccess.example/__oa/runtime.js');
    expect(out).not.toContain('iso-8859-1');
    expect(out).not.toContain('http-equiv="Content-Security-Policy"');
  });

  it('rewrites absolute references and leaves relative ones to the base', () => {
    expect(out).toContain(`href="${proxy('https', 'site.example', '/next')}"`);
    expect(out).toContain('href="rel.html"');
    expect(out).toContain(`src="${proxy('https', 'site.example', '/app.js')}"`);
    expect(out).toContain(`src="${proxy('https', 'site.example', '/frame')}"`);
    expect(out).toContain(`action="${proxy('https', 'site.example', '/submit')}"`);
    expect(out).toContain(`href="${proxy('https', 'site.example', '/style.css')}"`);
  });

  it('rewrites inline styles and style elements', () => {
    expect(out).toContain(proxy('https', 'site.example', '/bg.png'));
    expect(out).toContain(proxy('https', 'site.example', '/body.png'));
    expect(out).toContain('url(&quot;https://p.openaccess.example');
  });

  it('rewrites srcset while preserving data URLs and descriptors', () => {
    expect(out).toContain(`${proxy('https', 'site.example', '/one.png')} 1x`);
    expect(out).toContain('two.png 2x');
    expect(out).toContain('data:image/png;base64,AA,BB 3x');
  });

  it('strips integrity, nonce, crossorigin, CSP and preconnect hints', () => {
    expect(out).not.toContain('integrity=');
    expect(out).not.toContain('nonce=');
    expect(out).not.toContain('crossorigin=');
    expect(out).not.toContain('fonts.example');
    // Canonical stays pointing at the real site.
    expect(out).toContain('rel="canonical" href="https://site.example/dir/page.html"');
  });

  it('rewrites meta refresh and keeps srcdoc', () => {
    expect(out).toContain(`content="5; url=${proxy('https', 'site.example', '/elsewhere')}"`);
    expect(out).toContain('srcdoc="&lt;p&gt;inline&lt;/p&gt;"');
  });

  it('escapes the bootstrap JSON so it cannot break out of its script tag', () => {
    const dangerous = rewriteHtml('<html><head></head><body></body></html>', {
      ...options,
      cookieSnapshot: '</script><script>alert(1)</script>',
    });
    expect(dangerous).not.toContain('</script><script>alert(1)');
    expect(dangerous).toContain('\\u003c/script\\u003e');
  });

  it('handles documents with no head or body', () => {
    const out2 = rewriteHtml('<p>hi</p>', options);
    expect(out2).toContain('hi');
    expect(out2).toContain('<base');
  });

  it('keeps template content intact while rewriting it', () => {
    const out3 = rewriteHtml('<html><head></head><body><template><img src="/t.png"></template></body></html>', options);
    expect(out3).toContain(proxy('https', 'site.example', '/t.png'));
  });
});

describe('CSS rewriting', () => {
  const cssOptions = { token: TOKEN, documentUrl: doc, contentOrigin: 'https://p.openaccess.example' };

  it('rewrites url() and @import references', () => {
    const css = '@import "/base.css"; .a{background:url(/img.png)} .b{background:url("../up.png")} .c{background:url(data:image/png;base64,AA)}';
    const out = rewriteCss(css, cssOptions);
    expect(out).toContain(`@import "${proxy('https', 'site.example', '/base.css')}"`);
    expect(out).toContain(`url("${proxy('https', 'site.example', '/img.png')}")`);
    expect(out).toContain('url("../up.png")');
    expect(out).toContain('url(data:image/png;base64,AA)');
  });

  it('does not touch comments or strings that merely contain url(', () => {
    const css = '/* url(/x.png) */ .a::after{content:"url(/no.png)"}';
    expect(rewriteCss(css, cssOptions)).toBe(css);
  });

  it('handles quoted and uppercase url() syntax', () => {
    const out = rewriteCss('a{background:URL( "/x.png" )} b{background:url(\'/y.png\')}', cssOptions);
    expect(out).toContain(`url("${proxy('https', 'site.example', '/x.png')}")`);
    expect(out).toContain(`url("${proxy('https', 'site.example', '/y.png')}")`);
  });
});
