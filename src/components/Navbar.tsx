"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, FileText, Mail, ShieldCheck, UploadCloud } from "lucide-react";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/ingest", label: "Ingest & Review", icon: UploadCloud },
  { href: "/briefings", label: "Briefings", icon: FileText },
  { href: "/automation", label: "Gmail Automation", icon: Mail },
  { href: "/ops", label: "Ops & Evals", icon: ShieldCheck },
];

export function Navbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#090d16]/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <span className="text-base font-semibold tracking-tight text-white">LedgerPulse</span>
            <span className="ml-2 hidden rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300 sm:inline-block">
              Evidence-Gated AI
            </span>
          </div>
        </Link>

        <nav className="flex items-center gap-1 overflow-x-auto">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                    : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-100"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
