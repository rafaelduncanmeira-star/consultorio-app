import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Patient } from "@/lib/types";
import { Button, EmptyState } from "@/components/ui";

export default async function PacientesPage() {
  const { user, membership } = await getSessionContext();
  if (!user) redirect("/login");
  if (!membership) redirect("/pro/onboarding");

  const supabase = await createClient();
  const { data: patients } = await supabase
    .from("patients")
    .select("*")
    .eq("clinic_id", membership.clinic_id)
    .order("name");

  const list = (patients ?? []) as Patient[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">Pacientes</h1>
        <Link href="/pro/pacientes/novo">
          <Button>+ Novo paciente</Button>
        </Link>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="Nenhum paciente ainda"
          description="Cadastre o primeiro paciente para começar o acompanhamento."
          action={
            <Link href="/pro/pacientes/novo">
              <Button variant="secondary">Cadastrar paciente</Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Nome</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">
                  Telefone
                </th>
                <th className="px-4 py-3 font-medium">App</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/pro/pacientes/${p.id}`}
                      className="font-medium text-slate-800 hover:text-brand-700"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="hidden px-4 py-3 text-slate-500 sm:table-cell">
                    {p.phone ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {p.user_id ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                        conectado
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                        sem acesso
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
