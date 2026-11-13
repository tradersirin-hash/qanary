// A scan link keeps the scanned address in the URL fragment (#a=…). Browsers never send the fragment to a server, nor
// in a Referer header, so opening a shared link does not tell this site which address it is. Older links put the
// address in the query (?a=); they still open, and the address then moves into the fragment.

/** The fragment that holds `address`, with its leading #. */
export function addressHash(address: string): string {
  return `#${new URLSearchParams({ a: address }).toString()}`;
}

/** True if a fragment (with or without its #) holds a scanned address. */
export function hasAddress(hash: string): boolean {
  return new URLSearchParams(hash.replace(/^#/, '')).has('a');
}

/** The scanned address in a URL: the fragment's a= first, then an older link's ?a=; '' if neither. */
export function addressFromUrl(search: string, hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('a') || new URLSearchParams(search).get('a') || '';
}

/** The path and query (without ?a=) followed by `address` in the fragment; an empty address leaves no fragment. */
export function urlWithAddress(pathname: string, search: string, address: string): string {
  const params = new URLSearchParams(search);
  params.delete('a');
  const query = params.toString();
  return pathname + (query ? `?${query}` : '') + (address ? addressHash(address) : '');
}
