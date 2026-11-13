import { describe, expect, it } from 'vitest';
import { normalizedUrl } from './router';
import { addressFromUrl, addressHash, hasAddress, urlWithAddress } from './scanLink';

const SOL = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const EVM = '0x0000000000000000000000000000000000000001';

describe('scan links keep the address in the fragment', () => {
  it('writes the address after # and drops an older ?a=', () => {
    expect(urlWithAddress('/', '', SOL)).toBe(`/#a=${SOL}`);
    expect(urlWithAddress('/', `?a=${EVM}`, SOL)).toBe(`/#a=${SOL}`);
    expect(urlWithAddress('/', '?utm_source=x&a=old', EVM)).toBe(`/?utm_source=x#a=${EVM}`);
  });

  it('leaves no fragment and no ?a= for an empty address', () => {
    expect(urlWithAddress('/', '?a=old', '')).toBe('/');
    expect(urlWithAddress('/', '?ref=1', '')).toBe('/?ref=1');
  });

  it('reads the fragment first, then an older ?a=', () => {
    expect(addressFromUrl('', `#a=${SOL}`)).toBe(SOL);
    expect(addressFromUrl(`?a=${EVM}`, `#a=${SOL}`)).toBe(SOL);
    expect(addressFromUrl(`?a=${EVM}`, '')).toBe(EVM);
    expect(addressFromUrl(`?a=${EVM}`, '#main')).toBe(EVM);
    expect(addressFromUrl('', '#main')).toBe('');
    expect(addressFromUrl('', '')).toBe('');
  });

  it('round-trips any address it writes', () => {
    for (const a of [SOL, EVM, 'not an address & more=1']) {
      const url = new URL(urlWithAddress('/', '?x=1', a), 'https://qanary.xyz');
      expect(addressFromUrl(url.search, url.hash)).toBe(a);
      expect(url.searchParams.has('a')).toBe(false);
    }
  });

  it('knows which fragments hold an address', () => {
    expect(hasAddress(addressHash(SOL))).toBe(true);
    expect(hasAddress(`a=${SOL}`)).toBe(true);
    expect(hasAddress('#main')).toBe(false);
    expect(hasAddress('#vault')).toBe(false);
    expect(hasAddress('')).toBe(false);
  });
});

describe('normalizedUrl', () => {
  it("moves an older link's ?a= into the fragment on the scanner page", () => {
    expect(normalizedUrl('/', `?a=${SOL}`, '')).toBe(`/#a=${SOL}`);
    expect(normalizedUrl('/', `?ref=x&a=${SOL}`, '')).toBe(`/?ref=x#a=${SOL}`);
    expect(normalizedUrl('/index.html', `?a=${SOL}`, '')).toBe(`/#a=${SOL}`);
  });

  it('keeps a fragment address over an older ?a=', () => {
    expect(normalizedUrl('/', `?a=${EVM}`, `#a=${SOL}`)).toBe(`/#a=${SOL}`);
  });

  it('leaves a current scan link as it is', () => {
    expect(normalizedUrl('/', '', `#a=${SOL}`)).toBe(`/#a=${SOL}`);
    expect(normalizedUrl('/', '', '')).toBe('/');
  });

  it('drops the scanned address from other pages, in either place', () => {
    expect(normalizedUrl('/vault', `?a=${SOL}`, '')).toBe('/vault');
    expect(normalizedUrl('/bounty', '', `#a=${SOL}`)).toBe('/bounty');
    expect(normalizedUrl('/how/', '?ref=x', `#a=${SOL}`)).toBe('/how?ref=x');
  });

  it('still turns old section links into pages', () => {
    expect(normalizedUrl('/', '', '#vault')).toBe('/vault');
    expect(normalizedUrl('/', `?a=${SOL}`, '#bounty')).toBe('/bounty');
    expect(normalizedUrl('/', '', '#scan')).toBe('/');
  });

  it('keeps other fragments on other pages', () => {
    expect(normalizedUrl('/how', '', '#main')).toBe('/how#main');
  });
});
