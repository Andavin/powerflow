"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  FlowNavIcon,
  CircuitsNavIcon,
  StatsNavIcon,
  OverviewNavIcon,
} from "./icons";
import { Wordmark } from "./primitives";

interface NavItem {
  href: string;
  label: string;
  icon: typeof FlowNavIcon;
}

const MOBILE_NAV: NavItem[] = [
  { href: "/", label: "Flow", icon: FlowNavIcon },
  { href: "/circuits", label: "Circuits", icon: CircuitsNavIcon },
  { href: "/stats", label: "Stats", icon: StatsNavIcon },
];

const DESKTOP_NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: OverviewNavIcon },
  { href: "/circuits", label: "Circuits", icon: CircuitsNavIcon },
  { href: "/stats", label: "Stats", icon: StatsNavIcon },
];

function useLogout() {
  const router = useRouter();
  return async () => {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const logout = useLogout();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface/40 px-4 py-6 lg:flex">
        <div className="px-2 text-lg">
          <Wordmark />
        </div>
        <nav aria-label="Sidebar" className="mt-8 flex flex-1 flex-col gap-1">
          {DESKTOP_NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface/60 hover:text-fg"
                }`}
              >
                <Icon width={20} height={20} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={logout}
          className="rounded-xl px-3 py-2.5 text-left text-sm text-muted transition hover:bg-surface/60 hover:text-fg"
        >
          Sign out
        </button>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg/80 px-4 py-3 backdrop-blur [transform:translateZ(0)] lg:hidden">
        <Wordmark />
        <button onClick={logout} aria-label="Sign out" className="text-sm text-muted">
          Sign out
        </button>
      </header>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-5 lg:px-8 lg:pt-8 lg:pb-10">{children}</main>

        {/* Mobile bottom nav */}
        <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur [transform:translateZ(0)] lg:hidden">
          {MOBILE_NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] ${
                  active ? "text-fg" : "text-faint"
                }`}
              >
                <Icon width={22} height={22} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
