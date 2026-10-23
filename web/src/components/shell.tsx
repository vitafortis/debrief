"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  CalendarDays,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { contextColor } from "@/lib/colors";
import { setContext } from "@/actions/context";
import { signOutAction } from "@/actions/session";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/meetings", label: "Meetings", icon: MessagesSquare },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/search", label: "Search", icon: Search },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings },
];

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  return [
    theme,
    (t: "dark" | "light") => {
      document.documentElement.dataset.theme = t;
      try {
        localStorage.setItem("debrief-theme", t);
      } catch {}
      setTheme(t);
    },
  ] as const;
}

export function Shell({
  children,
  viewer,
  canSignOut,
  contexts,
  context,
  pendingTasks,
  version,
}: {
  children: React.ReactNode;
  viewer: { name: string | null; email: string | null };
  canSignOut: boolean;
  contexts: string[];
  context: string | null;
  pendingTasks: number;
  version: string;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useTheme();
  const [, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const item = "relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[0.8125rem] font-medium transition-colors";
  const on = "bg-accent text-foreground shadow-surface";
  const off = "text-muted-foreground hover:bg-accent/70 hover:text-foreground";
  const pick = (c: string | null) => startTransition(() => setContext(c));

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        className={`hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 md:flex ${collapsed ? "w-14" : "w-64"}`}
      >
        <div className="flex h-14 items-center gap-2.5 px-3.5">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo size={26} />
            {!collapsed && <span className="text-[0.9375rem] font-semibold tracking-tight">Debrief</span>}
          </Link>
        </div>

        <nav className="space-y-0.5 px-2 pt-1">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} title={n.label} className={`${item} ${active ? on : off}`}>
                {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary" />}
                <n.icon className="size-4 shrink-0" />
                {!collapsed && <span className="flex-1">{n.label}</span>}
                {!collapsed && n.href === "/tasks" && pendingTasks > 0 && (
                  <span className="rounded-md bg-primary-soft px-1.5 font-mono text-[0.6875rem] text-primary tabular-nums">{pendingTasks}</span>
                )}
              </Link>
            );
          })}
        </nav>

        {contexts.length > 1 && (
          <>
            {!collapsed && (
              <div className="mt-5 px-4 pb-1.5">
                <span className="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Calendars</span>
              </div>
            )}
            <div className="space-y-0.5 px-2">
              {[null, ...contexts].map((c) => {
                const active = context === c;
                return (
                  <button
                    key={c ?? "all"}
                    onClick={() => pick(c)}
                    title={c ?? "All calendars"}
                    className={`${item} w-full text-left ${active ? on : off} ${collapsed ? "mt-1" : ""}`}
                  >
                    {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary" />}
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: c ? contextColor(c, contexts) : "var(--muted-foreground)" }}
                    />
                    {!collapsed && <span className="truncate capitalize">{c ?? "All"}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="flex-1" />
        {!collapsed && (viewer.name || viewer.email) && (
          <div className="flex items-center gap-2.5 border-t border-border px-3 py-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-[0.6875rem] font-semibold text-primary uppercase">
              {(viewer.name ?? viewer.email ?? "?").slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{viewer.name ?? viewer.email}</p>
              {viewer.name && viewer.email && <p className="truncate text-[0.6875rem] text-muted-foreground">{viewer.email}</p>}
            </div>
          </div>
        )}
        <div className={`flex items-center gap-1 border-t border-border p-2 ${collapsed ? "flex-col" : ""}`}>
          <button className="btn btn-ghost btn-icon btn-sm" title="Toggle sidebar (⌘B)" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="Toggle theme"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
          {!collapsed && <span className="ml-1 truncate font-mono text-[0.6875rem] text-muted-foreground/70">v{version}</span>}
          {canSignOut && (
            <form action={signOutAction} className={collapsed ? "" : "ml-auto"}>
              <button className="btn btn-ghost btn-icon btn-sm" title="Sign out">
                <LogOut />
              </button>
            </form>
          )}
        </div>
      </aside>

      <main className="relative min-w-0 flex-1 overflow-y-auto pb-16 md:pb-0">{children}</main>

      {/* Phones: a bottom bar instead of the sidebar. */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface/95 backdrop-blur md:hidden">
        {NAV.filter((n) => n.href !== "/settings").map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.625rem] font-medium ${active ? "text-primary" : "text-muted-foreground"}`}
            >
              <n.icon className="size-5" />
              {n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
