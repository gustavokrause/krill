export function KrillIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {/* antennae */}
      <line x1="6" y1="10" x2="1" y2="3" />
      <line x1="6" y1="10" x2="2" y2="6" />
      {/* eye */}
      <circle cx="6" cy="11" r="0.8" fill="currentColor" stroke="none" />
      {/* carapace top arc */}
      <path d="M6 9 C10 6 15 7 17 10" />
      {/* belly */}
      <line x1="6" y1="12" x2="16" y2="12" />
      {/* abdomen — bent downward (key krill silhouette) */}
      <path d="M17 10 C19 12 18 14 16 17" />
      {/* tail fan */}
      <line x1="16" y1="17" x2="13" y2="21" />
      <line x1="16" y1="17" x2="16" y2="21" />
      <line x1="16" y1="17" x2="19" y2="21" />
      {/* legs */}
      <line x1="9" y1="12" x2="9" y2="15" />
      <line x1="12" y1="12" x2="12" y2="15" />
      <line x1="15" y1="12" x2="15" y2="15" />
    </svg>
  );
}
