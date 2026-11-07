import type { ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";

/** Renders a server-side page. React escapes all interpolated values, which is our XSS control. */
export function page(el: ReactElement, init: { status?: number } = {}): Response {
  return new Response(`<!doctype html>${renderToString(el)}`, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const css = `body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
button{padding:.4rem .9rem}label{display:block;margin:.3rem 0}`;

export function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · Secure Documents`}</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}

export const STYLESHEET = css;
