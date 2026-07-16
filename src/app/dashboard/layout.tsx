import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { getOrCreateCurrentUser } from "@/lib/users";

const baseNavItems = [
  { href: "/dashboard", label: "My Apps" },
  { href: "/dashboard/create", label: "Create New App" },
  { href: "/dashboard/change", label: "Change an App" },
];

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getOrCreateCurrentUser().catch(() => null);
  const navItems =
    user?.role === "admin"
      ? [...baseNavItems, { href: "/dashboard/admin", label: "Admin" }]
      : baseNavItems;
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-forge-600 text-lg text-white">
              ⚒
            </span>
            <span className="text-lg font-bold text-forge-900">
              VoiceForge V2
            </span>
          </Link>
          <nav className="hidden gap-1 sm:flex">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-forge-100 hover:text-forge-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <UserButton />
        </div>
        {/* Mobile nav */}
        <nav className="flex justify-around border-t border-slate-100 sm:hidden">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex-1 px-2 py-2 text-center text-xs font-medium text-slate-600"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
