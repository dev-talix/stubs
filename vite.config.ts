import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  plugins: [cloudflare(), ticketPage()],
  // The CSP only allows same-origin fonts and scripts, so never inline assets as data: URIs.
  build: { assetsInlineLimit: 0 },
});
