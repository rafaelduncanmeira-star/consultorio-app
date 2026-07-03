import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Patient, PatientInvite } from "@/lib/types";
import { createPatientInvite, updatePatient } from "../../actions";
import {
  Alert,
  Button,
  Card,
  Input,
  Label,
  Textarea,
} from "@/components/ui";
import { InviteLink } from "@/components/invite-link";

export default async function PacientePerfilPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ erro?: string; msg?: string }>;
}) {
  const [{ id }, { erro, msg }] = await Promise.all([params, searchParams]);

  const { user, membership } = await getSessionContext();
  if (!user) redirect("/login");
  if (!membership) redirect("/pro/onboarding");

  const supabase = await createClient();
  const { data: patientRow } = await supabase
    .from("patients")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!patientRow) notFound();
  const patient = patientRow as Patient;

  const { data: inviteRows } = await supabase
    .from("patient_invites")
    .select("*")
    .eq("patient_id", id)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  const activeInvite = (inviteRows?.[0] as PatientInvite | undefined) ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">{patient.name}</h1>
        {patient.user_id ? (
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
            conectado ao app
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
            sem acesso ao app
          </span>
        )}
      </div>

      {msg === "salvo" && <Alert kind="success">Dados salvos.</Alert>}
      {msg === "convite" && (
        <Alert kind="success">Convite gerado! Copie o link abaixo e envie ao paciente.</Alert>
      )}
      {erro === "salvar" && (
        <Alert kind="error">Não foi possível salvar. Tente novamente.</Alert>
      )}
      {erro === "convite" && (
        <Alert kind="error">Não foi possível gerar o convite.</Alert>
      )}

      {!patient.user_id && (
        <Card>
          <h2 className="mb-3 font-semibold text-slate-800">
            Acesso do paciente ao app
          </h2>
          {activeInvite ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-600">
                Envie este link para {patient.name.split(" ")[0]} (vale até{" "}
                {new Date(activeInvite.expires_at).toLocaleDateString("pt-BR")}
                ):
              </p>
              <InviteLink token={activeInvite.token} />
            </div>
          ) : (
            <form action={createPatientInvite}>
              <input type="hidden" name="patient_id" value={patient.id} />
              <p className="mb-3 text-sm text-slate-600">
                Gere um convite para o paciente criar a conta e acompanhar o
                próprio cuidado pelo app.
              </p>
              <Button type="submit" variant="secondary">
                Gerar convite
              </Button>
            </form>
          )}
        </Card>
      )}

      <Card>
        <h2 className="mb-3 font-semibold text-slate-800">Dados do paciente</h2>
        <form action={updatePatient} className="space-y-4">
          <input type="hidden" name="id" value={patient.id} />
          <div>
            <Label htmlFor="name">Nome completo *</Label>
            <Input id="name" name="name" defaultValue={patient.name} required />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="phone">Telefone / WhatsApp</Label>
              <Input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={patient.phone ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="birth_date">Nascimento</Label>
              <Input
                id="birth_date"
                name="birth_date"
                type="date"
                defaultValue={patient.birth_date ?? ""}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              name="email"
              type="email"
              defaultValue={patient.email ?? ""}
            />
          </div>
          <div>
            <Label htmlFor="notes">Observações</Label>
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              defaultValue={patient.notes ?? ""}
            />
          </div>
          <Button type="submit">Salvar alterações</Button>
        </form>
      </Card>

      <Card className="opacity-60">
        <h2 className="font-semibold text-slate-800">Plano de cuidado</h2>
        <p className="text-sm text-slate-500">
          Em breve: prescrição de remédios e atividades com lembretes e adesão.
        </p>
      </Card>
    </div>
  );
}
