// Every entry carries the page it came from. Researched and cross-checked on 2026-10-09.
export type Entry = { date: string; text: string; url: string; highlight?: boolean };
export type Stat = { value: string; text: string; url: string };

export const RECORD = {
  bits: 15,
  targetBits: 256,
  text: 'Project Eleven Q-Day Prize (1 BTC), April 2026. Critics note the same result can be reproduced classically.',
  url: 'https://www.coindesk.com/tech/2026/04/24/researcher-wins-1-bitcoin-bounty-for-largest-quantum-attack-on-underlying-tech',
};

export const STATS: Stat[] = [
  {
    value: '28–49%',
    text: 'chance of a cryptographically relevant quantum computer within 10 years (26 experts, Global Risk Institute, 2026).',
    url: 'https://globalriskinstitute.org/publication/quantum-threat-timeline-report-2025b/',
  },
  {
    value: '3–5%',
    text: "Anza's estimate for a machine that breaks 256-bit elliptic curves within 5 years.",
    url: 'https://www.anza.xyz/blog/securing-solana-against-a-powerful-quantum-adversary',
  },
  {
    value: '6M+ BTC',
    text: 'already sit behind exposed public keys (Glassnode, October 2026).',
    url: 'https://www.coindesk.com/markets/2026/10/08/over-6-million-bitcoin-sit-behind-exposed-public-keys-as-ai-warnings-mount',
  },
];

export const ESTIMATES: Entry[] = [
  {
    date: '2019-05',
    text: 'RSA-2048: about 20 million noisy qubits, 8 hours (Gidney and Ekerå).',
    url: 'https://arxiv.org/abs/1905.09749',
  },
  {
    date: '2025-05',
    text: 'RSA-2048: under 1 million noisy qubits, under a week (Gidney, Google).',
    url: 'https://arxiv.org/abs/2505.15917',
  },
  {
    date: '2026-02',
    text: 'RSA-2048: under 100,000 qubits with qLDPC codes (Iceberg Quantum, claim).',
    url: 'https://thequantuminsider.com/2026/03/31/q-day-just-got-closer-three-papers-in-three-months-are-rewriting-the-quantum-threat-timeline/',
  },
  {
    date: '2026-03',
    highlight: true,
    text: '256-bit elliptic curves (Bitcoin, Ethereum, Solana): about 1,200–1,450 logical qubits, under 500,000 physical qubits, minutes per key (Google Quantum AI).',
    url: 'https://arxiv.org/abs/2603.28846',
  },
  {
    date: '2026-03',
    text: "Neutral atoms: Shor's algorithm with as few as 10,000 atoms; about 26,000 qubits to break a 256-bit elliptic-curve key (P-256) in a few days (Caltech and Oratomic, not peer-reviewed).",
    url: 'https://arxiv.org/abs/2603.28627',
  },
  {
    date: '2026-09',
    text: 'Open challenge ECDSA.Fail pushes the benchmark down to 1,151 logical qubits (Eigen Labs).',
    url: 'https://www.theblock.co/news/ecosystems/2026-09-10-researchers-halve-quantum-resource-benchmark-for-key-operation-in-bitcoin-ethereum-attack-414121',
  },
];

export const DEADLINES: Entry[] = [
  {
    date: '2026-04',
    text: 'Solana: Anza and Firedancer pick Falcon for future post-quantum wallets; "no change is required today".',
    url: 'https://solana.com/news/quantum-readiness',
  },
  {
    date: '2029-12',
    text: 'Ethereum Foundation target: post-quantum transactions, validators and data.',
    url: 'https://www.coindesk.com/tech/2026/09/08/ethereum-makes-quantum-resistance-a-top-priority-with-a-2029-deadline',
  },
  {
    date: '2030 / 2035',
    text: 'NIST IR 8547 draft: 112-bit RSA and elliptic-curve parameters (e.g. RSA-2048) deprecated after 2030; all RSA and elliptic-curve signatures, Ed25519 included, disallowed after 2035.',
    url: 'https://csrc.nist.gov/pubs/ir/8547/ipd',
  },
];
