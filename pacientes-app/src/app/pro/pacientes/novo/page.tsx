import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { createPatient } from "../../actions";
import { Alert, Button, Card, Input, Label, Textarea } from "@/components/ui";

export default async function NovoPacientePage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const { erro } = await searchParams;
  const { user, membership } = await getSessionContext();
  if (!user) redirect("/login");
  if (!membership) redirect("/pro/onboarding");

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-bold text-slate-800">Novo paciente</h1>

      {erro === "nome" && <Alert kind="error">Informe o nome do paciente.</Alert>}
      {erro === "salvar" && (
        <Alert kind="error">Não foi possível salvar. Tente novamente.</Alert>
      )}

      <Card>
        <form action={createPatient} className="space-y-4">
          <div>
            <Label htmlFor="name">Nome completo *</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="phone">Telefone / WhatsApp</Label>
              <Input id="phone" name="phone" type="tel" placeholder="(11) 99999-9999" />
            </div>
            <div>
              <Label htmlFor="birth_date">Nascimento</Label>
              <Input id="birth_date" name="birth_date" type="date" />
            </div>
          </div>
          <div>
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" name="email" type="email" />
          </div>
          <div>
            <Label htmlFor="notes">Observações</Label>
            <Textarea id="notes" name="notes" rows={3} />
          </div>
          <Button type="submit" className="w-full">
            Salvar paciente
          </Button>
        </form>
      </Card>
    </div>
  );
}
