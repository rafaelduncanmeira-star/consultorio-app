import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { logout } from "@/app/(auth)/actions";

const NAV = [
  { href: "/paciente", label: "Hoje", icon: "☀️" },
  { href: "/paciente/consultas", label: "Consultas", icon: "📅" },
  { href: "/paciente/programa", label: "Programa", icon: "🎯" },
  { href: "/paciente/chat", label: "Chat", icon: "💬" },
];

export default async function PacienteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, patient, membership } = await getSessionContext();

  if (!user) redirect("/login");
  if (!patient) redirect(membership ? "/pro" : "/pro/onboarding");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <p className="text-xs text-slate-400">Olá,</p>
          <p className="font-semibold text-slate-800">
            {patient.name.split(" ")[0]}
          </p>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Sair
          </button>
        </form>
      </header>

      <main className="flex-1 px-4 py-4 pb-24">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white">
        <div className="mx-auto grid max-w-md grid-cols-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col items-center gap-0.5 py-2.5 text-xs text-slate-500 hover:text-brand-700"
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
