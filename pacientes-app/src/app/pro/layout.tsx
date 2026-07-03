import Link from "next/link";
import { logout } from "@/app/(auth)/actions";
import { getSessionContext } from "@/lib/auth";

export default async function ProLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { membership } = await getSessionContext();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/pro" className="text-lg font-bold text-brand-700">
              Vitalis
            </Link>
            {membership && (
              <nav className="flex items-center gap-4 text-sm">
                <Link
                  href="/pro"
                  className="text-slate-600 hover:text-brand-700"
                >
                  Início
                </Link>
                <Link
                  href="/pro/pacientes"
                  className="text-slate-600 hover:text-brand-700"
                >
                  Pacientes
                </Link>
                <span
                  className="cursor-default text-slate-300"
                  title="Em breve"
                >
                  Agenda
                </span>
                <span
                  className="cursor-default text-slate-300"
                  title="Em breve"
                >
                  Programas
                </span>
              </nav>
            )}
          </div>
          <div className="flex items-center gap-3">
            {membership && (
              <span className="hidden text-sm text-slate-500 sm:inline">
                {membership.clinic_name}
              </span>
            )}
            <form action={logout}>
              <button
                type="submit"
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
