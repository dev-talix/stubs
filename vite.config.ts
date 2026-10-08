import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

const CLI_VERSION: string = JSON.parse(readFileSync(new URL("./cli/package.json", import.meta.url), "utf8")).version;
const VERSION_PLACEHOLDER = "{{STUBS_CLI_VERSION}}";

/**
 * Every CLI command the site shows pins the version in cli/package.json. index.html gets it on
 * the way through Vite's HTML pipeline (dev and build), and llms.txt is emitted from src/llms.txt
 * at build time; it isn't served by the dev server.
 */
function cliVersion(): Plugin {
  const stamp = (text: string) => text.replaceAll(VERSION_PLACEHOLDER, CLI_VERSION);
  return {
    name: "stubs-cli-version",
    transformIndexHtml: stamp,
    generateBundle() {
      const template = readFileSync(new URL("./src/llms.txt", import.meta.url), "utf8");
      this.emitFile({ type: "asset", fileName: "llms.txt", source: stamp(template) });
    },
  };
}

// Stub links (/t#…) get their own share card. Link unfurlers fetch /t without the fragment, so
// all they can ever see is this static page: no key, and nothing that opens or burns a stub.
const TICKET_SHARE = `<title>A stub for you · Stubs</title>
    <meta name="robots" content="noindex" />
    <meta name="description" content="Someone sent you .env values. They're encrypted, and this link opens once." />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Stubs" />
    <meta property="og:url" content="https://stubs.talix.app/t" />
    <meta property="og:title" content="Someone sent you a stub" />
    <meta property="og:description" content="Encrypted .env values. The link opens once, then it's void." />
    <meta property="og:image" content="https://stubs.talix.app/og-ticket.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="A sealed Stubs ticket reading ADMIT ONE, with a TEAR TO REVEAL button" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Someone sent you a stub" />
    <meta name="twitter:description" content="Encrypted .env values. The link opens once, then it's void." />
    <meta name="twitter:image" content="https://stubs.talix.app/og-ticket.png" />`;

/** Emits t.html: the built index.html with the share block swapped for the stub version. */
function ticketPage(): Plugin {
  return {
    name: "stubs-ticket-page",
    apply: "build",
    // After Vite's own HTML plugin, which adds index.html to the bundle in this same hook.
    enforce: "post",
    generateBundle(_options, bundle) {
      const index = bundle["index.html"];
      if (!index || index.type !== "asset") return;
      const html = String(index.source);
      const block = /<!-- share:start[\s\S]*?<!-- share:end -->/;
      if (!block.test(html)) this.error("index.html is missing its share:start/share:end block");
      this.emitFile({ type: "asset", fileName: "t.html", source: html.replace(block, TICKET_SHARE) });
    },
  };
}

// Pages built from their own HTML. security.html is static (styles only, no script), so Workers
// Assets serves it at /security before the SPA fallback is reached.
const PAGES = ["index.html", "security.html"].map((page) => fileURLToPath(new URL(`./${page}`, import.meta.url)));

export default defineConfig({
  plugins: [cloudflare(), cliVersion(), ticketPage()],
  // The CSP only allows same-origin fonts and scripts, so never inline assets as data: URIs.
  build: { assetsInlineLimit: 0 },
  environments: { client: { build: { rollupOptions: { input: PAGES } } } },
});
