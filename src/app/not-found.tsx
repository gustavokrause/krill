import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-12 flex flex-col items-center">
      <div className="max-w-md border border-dashed border-border rounded-sm p-6 w-full">
        <h1 className="text-lg font-bold">Not found</h1>
        <p className="text-sm text-text-2 mt-1">
          The page or resource does not exist.
        </p>
        <Link
          href="/"
          className="inline-flex items-center h-9 px-4 mt-5 rounded bg-primary text-white text-sm font-medium hover:opacity-90"
        >
          Back to board
        </Link>
      </div>
    </main>
  );
}
