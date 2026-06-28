import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { isAuthenticated } from "@/lib/session";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defense in depth: the proxy already gates, but verify server-side too.
  if (!(await isAuthenticated())) {
    redirect("/login");
  }
  return <AppShell>{children}</AppShell>;
}
