// Where the Content-Security-Policy in vercel.json lets the page connect. Pure, so vite.config.ts can check the RPCs
// a build is configured with, and the tests every host the app reads.

type VercelHeaders = { headers?: { headers: { key: string; value: string }[] }[] };

/** The connect-src sources of the Content-Security-Policy vercel.json sends (its default-src if it has none);
 *  null when it sends no policy or the policy does not limit connections. */
export function connectSources(vercel: VercelHeaders): string[] | null {
  const policy = vercel.headers?.flatMap((rule) => rule.headers).find((h) => h.key.toLowerCase() === 'content-security-policy');
  if (!policy) return null;
  const directives = new Map(
    policy.value.split(';').map((directive): [string, string[]] => {
      const [name = '', ...sources] = directive.trim().split(/\s+/);
      return [name.toLowerCase(), sources];
    }),
  );
  return directives.get('connect-src') ?? directives.get('default-src') ?? null;
}

/** Whether the page may connect to `url`: a source with its scheme and host (a `*.` source covers subdomains), or
 *  its bare scheme. A URL that does not parse is never allowed. */
export function allowsConnect(sources: readonly string[] | null, url: string): boolean {
  if (sources === null) return true;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return sources.some((source) => {
    if (source === target.protocol) return true;
    const [scheme, rest] = source.split('://');
    if (rest === undefined || `${scheme}:` !== target.protocol) return false;
    const host = rest.split('/')[0];
    return host.startsWith('*.') ? target.host.endsWith(host.slice(1)) : target.host === host;
  });
}
