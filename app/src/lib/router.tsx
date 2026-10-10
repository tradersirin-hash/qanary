import { useSyncExternalStore, type ComponentProps } from 'react';

/** Every page has its own path. app/vercel.json rewrites these paths to index.html so they also load directly. */
export const PATHS = {
  home: '/',
  how: '/how',
  vault: '/vault',
  bounty: '/bounty',
  qday: '/qday',
  roadmap: '/roadmap',
} as const;
export type Page = keyof typeof PATHS;
export type Route = Page | 'notFound';

export function parseRoute(pathname: string): Route {
  const path = pathname.toLowerCase().replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/';
  for (const [page, p] of Object.entries(PATHS)) if (p === path) return page as Page;
  return 'notFound';
}

// Links from the old one-page site pointed at sections: /#vault and so on.
const LEGACY_HASH: Record<string, Page> = { '#scan': 'home', '#how': 'how', '#vault': 'vault', '#bounty': 'bounty', '#qday': 'qday' };

/** Runs once before the first render: rewrites old section links, /index.html, trailing slashes and odd casing to the
 *  page's own path, and drops the scanner's ?a= from other pages. */
export function normalizeInitialUrl() {
  const { pathname, search, hash } = window.location;
  let route = parseRoute(pathname);
  let nextHash = hash;
  if (route === 'home' && LEGACY_HASH[hash]) {
    route = LEGACY_HASH[hash];
    nextHash = '';
  }
  const params = new URLSearchParams(search);
  if (route !== 'home') params.delete('a');
  const query = params.toString();
  const next = (route === 'notFound' ? pathname : PATHS[route]) + (query ? `?${query}` : '') + nextHash;
  if (next !== pathname + search + hash) window.history.replaceState(null, '', next);
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('popstate', onChange);
  };
}

const currentPath = () => window.location.pathname;

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, currentPath));
}

export function navigate(to: string) {
  // The link to the page already shown: no new history entry, just back to its top.
  if (parseRoute(to) === parseRoute(window.location.pathname)) {
    if (to !== window.location.pathname) window.history.replaceState(null, '', to + window.location.search);
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }
  window.history.pushState(null, '', to);
  for (const l of listeners) l();
}

/** A page link: a real href for new tabs and crawlers, client-side navigation for plain left clicks. */
export function Link({ to, onClick, ...rest }: Omit<ComponentProps<'a'>, 'href'> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (rest.target && rest.target !== '_self') return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}
