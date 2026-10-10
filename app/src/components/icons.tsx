import type { ReactNode } from 'react';

type P = { className?: string };

function Icon({ className, children }: P & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ?? 'h-4 w-4'}
    >
      {children}
    </svg>
  );
}

export const Radar = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <path d="M12 12 19 5" />
  </Icon>
);
export const Lock = (p: P) => (
  <Icon {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);
export const AlertTriangle = (p: P) => (
  <Icon {...p}>
    <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </Icon>
);
export const Check = (p: P) => (
  <Icon {...p}>
    <path d="m5 12 4.5 4.5L19 7" />
  </Icon>
);
export const ArrowUpRight = (p: P) => (
  <Icon {...p}>
    <path d="M7 17 17 7M8 7h9v9" />
  </Icon>
);
export const Copy = (p: P) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Icon>
);
export const Key = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 9-9m-4 4 3 3" />
  </Icon>
);
export const ShieldCheck = (p: P) => (
  <Icon {...p}>
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);
export const Power = (p: P) => (
  <Icon {...p}>
    <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />
  </Icon>
);
export const Info = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
);
export const Branch = (p: P) => (
  <Icon {...p}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M6 7v10M8 12h8" />
  </Icon>
);
export const Code = (p: P) => (
  <Icon {...p}>
    <path d="m8 8-5 4 5 4m8-8 5 4-5 4M14 4l-4 16" />
  </Icon>
);
export const Bell = (p: P) => (
  <Icon {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Icon>
);
export const FileText = (p: P) => (
  <Icon {...p}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
    <path d="M14 3v6h6M8 13h8M8 17h5" />
  </Icon>
);
