import type { Metadata, Viewport } from "next";
import { Ubuntu, Ubuntu_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/app/nav";
import { Footer } from "@/components/app/footer";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getLanUrls } from "@/lib/lan";

const ubuntu = Ubuntu({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-ubuntu",
  display: "swap",
});

const ubuntuMono = Ubuntu_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-ubuntu-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "krill",
  description: "Local-first task pipeline for Claude Code. No goal-setting, no integrations, no infra.",
  icons: {
    icon: "/krill-512.png",
    apple: "/krill-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const SET_THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  const port = Number(process.env.PORT ?? 3000);
  const lanUrls = getLanUrls(port);
  return (
    <html lang="en" className={`${ubuntu.variable} ${ubuntuMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SET_THEME_SCRIPT }} />
      </head>
      <body className="font-sans bg-bg text-text antialiased h-screen flex flex-col overflow-hidden">
        <ToastProvider>
          <TooltipProvider>
            <Nav />
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">{children}</div>
            {modal}
            <Footer lanUrls={lanUrls} />
          </TooltipProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
