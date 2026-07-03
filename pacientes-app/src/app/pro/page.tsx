import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Button, Card } from "@/components/ui";

export default async function ProDashboard() {
  const { user, membership } = await getSessionContext();
  if (!user) redirect("/login");
  if (!membership) redirect("/pro/onboarding");

  const supabase = await createClient();
  const [{ count: totalPatients }, { count: linkedPatients }] =
    await Promise.all([
      supabase
        .from("patients")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", membership.clinic_id),
      supabase
        .from("patients")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", membership.clinic_id)
        .not("user_id", "is", null),
    ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">
          {membership.clinic_name}
        </h1>
        <Link href="/pro/pacientes/novo">
          <Button>+ Novo paciente</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <p className="text-sm text-slate-500">Pacientes</p>
          <p className="text-2xl font-bold text-slate-800">
            {totalPatients ?? 0}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-slate-500">No app</p>
          <p className="text-2xl font-bold text-brand-700">
            {linkedPatients ?? 0}
          </p>
        </Card>
        <Card className="opacity-50">
          <p className="text-sm text-slate-500">Consultas hoje</p>
          <p className="text-2xl font-bold text-slate-400">em breve</p>
        </Card>
        <Card className="opacity-50">
          <p className="text-sm text-slate-500">Adesão (7d)</p>
          <p className="text-2xl font-bold text-slate-400">em breve</p>
        </Card>
      </div>

      <Card>
        <h2 className="mb-2 font-semibold text-slate-800">Primeiros passos</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>
            Cadastre um paciente em{" "}
            <Link
              href="/pro/pacientes"
              className="text-brand-700 hover:underline"
            >
              Pacientes
            </Link>
            .
          </li>
          <li>
            No perfil do paciente, gere o <strong>convite</strong> e envie o
            link para ele instalar o app.
          </li>
          <li>
            Nas próximas versões: agenda, plano de cuidado com lembretes,
            programas e chat.
          </li>
        </ol>
      </Card>
    </div>
  );
}
