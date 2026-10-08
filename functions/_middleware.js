// Sanctions geo-blocking for the Cloudflare Pages deployment.
// Refuse a request that appears to come from a comprehensively embargoed
// jurisdiction with 451. Country-level check on the edge network's own
// geolocation; no list of named individuals is consulted.
//
// Check this list against the current OFAC programs before relying on it.
// https://ofac.treasury.gov/sanctions-programs-and-country-information
const BLOCKED_COUNTRIES = new Set([
  'CU', // Cuba
  'IR', // Iran
  'KP', // North Korea
  'SY', // Syria
]);

// Embargoed regions of Ukraine, as ISO 3166-2 subdivision codes without the
// country prefix: Crimea, Sevastopol, Donetsk, Luhansk, Kherson, Zaporizhzhia.
// Cloudflare reports these on request.cf.regionCode.
const BLOCKED_UA_REGIONS = new Set(['43', '40', '14', '09', '65', '23']);

const CONTACT = 'webmaster@shadowdewuff.gay';

export async function onRequest(context) {
  const cf = context.request.cf || {};
  const country = sanitize(cf.country);
  const region = sanitize(cf.regionCode);

  const blocked =
    BLOCKED_COUNTRIES.has(country) ||
    (country === 'UA' && BLOCKED_UA_REGIONS.has(region));

  if (!blocked) return context.next();

  return new Response(refusalPage(country), {
    status: 451,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

function sanitize(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function refusalPage(country) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Unavailable for legal reasons</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 2rem 1.25rem;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #fff;
    color: #1a1a1a;
  }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  .meta { color: #666; font-size: 0.875rem; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    .meta { color: #999; }
  }
</style>
</head>
<body>
<main>
  <h1>Unavailable for legal reasons</h1>
  <p>This site is not available from your location. The Owner and the site's
  hosting provider are subject to United States sanctions and export-control
  law, which does not permit serving comprehensively embargoed jurisdictions.</p>
  <p>This is a check on the country your connection appears to come from, and
  nothing else. Nothing has been decided about you as a person.</p>
  <p>That country is inferred from your IP address, so it can be wrong &mdash; a
  VPN or a misattributed address will produce the wrong answer. If you think
  this is a mistake, write to
  <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
  <p class="meta">HTTP 451${country ? ` &middot; detected country: ${country}` : ''}</p>
</main>
</body>
</html>
`;
}
