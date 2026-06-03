export function Footer({ lanUrls }: { lanUrls: string[] }) {
  return (
    <footer className="border-t border-border px-4 sm:px-6 lg:px-8 py-3 text-xs text-text-2 flex flex-wrap items-center gap-x-6 gap-y-1">
      <span>LAN trust model — anyone on this network can reach the app.</span>
      {lanUrls.length > 0 ? (
        <span className="font-mono">Phone: {lanUrls[0]}</span>
      ) : null}
    </footer>
  );
}
