import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { createClinicAction } from "../actions";
import { Alert, Button, Card, Input, Label } from "@/components/ui";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const { erro } = await searchParams;
  const { user, membership, patient } = await getSessionContext();

  if (!user) redirect("/login");
  if (membership) redirect("/pro");
  if (patient) redirect("/paciente");

  return (
    <div className="mx-auto max-w-md space-y-4 pt-10">
      <div className="text-center">
        <h1 className="text-xl font-bold text-slate-800">
          Bem-vindo(a) ao Vitalis!
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Para começar, dê um nome à sua clínica ou consultório.
        </p>
      </div>

      {erro === "nome" && <Alert kind="error">Informe um nome.</Alert>}
      {erro === "criar" && (
        <Alert kind="error">Não foi possível criar a clínica. Tente de novo.</Alert>
      )}

      <Card>
        <form action={createClinicAction} className="space-y-4">
          <div>
            <Label htmlFor="name">Nome da clínica</Label>
            <Input
              id="name"
              name="name"
              placeholder="Ex.: Clínica Duncan"
              required
            />
          </div>
          <Button type="submit" className="w-full">
            Criar clínica
          </Button>
        </form>
      </Card>
    </div>
  );
}
